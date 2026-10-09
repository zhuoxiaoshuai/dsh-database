import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { ConnectionService } from '../src/host/connection-service.ts'
import { connectionApi } from '../src/host/connection-api.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { memoryPasswordProtector } from '../src/password-protector.ts'

/** Only invoked by owned MySQL/Oracle fixtures. The database reply reaches Host, then HTTP is lost. */
export async function checkBrowserReceiptFaults(input, schema, readValue) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-http-receipt-'))
  const store = new ExecutionStore(directory)
  const service = new ConnectionService(() => true, directory, undefined, memoryPasswordProtector, store)
  let browser, server, hostServer, requests = 0, committed = 0, mode = 'drop'
  try {
    const connection = await service.open('http-probe', { ...input, environment: 'sit' }, false)
    await service.catalog('http-probe', connection.id, connection.generation, { kind: 'schemas', search: schema })
    await build({ stdin: { resolveDir: resolve('.'), loader: 'ts', contents: `
      import { connectionBridge } from './src/client/connection-bridge.ts'
      import { createSqlBatch, runSqlBatch } from './src/shared/sql-batch.ts'
      const connection = ${JSON.stringify({ ...connection, database: schema })}
      const bridge = connectionBridge('http-probe', {})
      let steps
      window.run = async value => {
        steps = await runSqlBatch({ steps: createSqlBatch(['UPDATE row_limit SET value=' + value + ' WHERE id=1']),
          signal: new AbortController().signal, execute: (sql, signal) => bridge.executeManual(connection, sql, signal) })
        return steps
      }
      window.retry = async () => {
        try {
          steps = await runSqlBatch({ steps: steps.map(step => ({ ...step, status: 'pending' })),
            signal: new AbortController().signal, execute: (sql, signal) => bridge.executeManual(connection, sql, signal) })
          return { blocked: false, steps }
        } catch (error) { return { blocked: true, message: error.message, steps } }
      }
      window.beforeCancel = async () => {
        const control = new AbortController(); control.abort()
        return runSqlBatch({ steps: createSqlBatch(['UPDATE row_limit SET value=999 WHERE id=1']),
          signal: control.signal, execute: (sql, signal) => bridge.executeManual(connection, sql, signal) })
      }
    ` }, bundle: true, format: 'esm', outfile: join(directory, 'browser.js') })
    hostServer = createServer((request, response) => { void connectionApi(service, store, 'http-probe', request, response) })
    await new Promise(ok => hostServer.listen(0, '127.0.0.1', ok))
    server = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.setHeader('Content-Type', request.url === '/browser.js' ? 'text/javascript' : 'text/html')
        response.end(request.url === '/browser.js' ? await readFile(join(directory, 'browser.js')) : '<script type="module" src="/browser.js"></script>')
        return
      }
      try {
        let body = ''; for await (const part of request) body += part
        const operation = JSON.parse(body); ++requests
        const upstream = await fetch(`http://127.0.0.1:${hostServer.address().port}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        })
        const result = await upstream.text()
        assert.equal(upstream.status, 200, 'production Host HTTP handler must return a real database receipt')
        const value = Number(operation.input.sql.match(/value=(\d+)/)[1])
        assert.equal(Number(await readValue()), value, 'independent DB connection must confirm commit before breaking HTTP')
        ++committed
        if (mode === 'drop') { response.destroy(); return }
        response.setHeader('Content-Type', 'application/json')
        // A truncated JSON body after a verified commit is not a database failure.
        response.end(result.slice(0, 12))
      } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })) }
    })
    await new Promise(ok => server.listen(0, '127.0.0.1', ok))
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction(() => window.run)
    assert.equal((await page.evaluate(() => window.beforeCancel()))[0].status, 'cancelled')
    assert.equal(requests, 0)
    for (const [index, fault] of ['drop', 'truncate'].entries()) {
      mode = fault
      const steps = await page.evaluate(value => window.run(value), 71 + index)
      assert.equal(steps[0].status, 'unknown'); assert.equal(committed, index + 1)
      const before = requests
      const retry = await page.evaluate(() => window.retry())
      assert.equal(retry.blocked, true); assert.equal(retry.steps[0].status, 'unknown')
      assert.equal(requests, before, 'unknown write cannot be resent')
      assert.equal(Number(await readValue()), 71 + index)
    }
    return `${input.dialect}: real Host→browser HTTP socket loss/truncated JSON after independently verified commit; unknown, zero replay; pre-dispatch cancel zero requests`
  } finally {
    await browser?.close()
    if (server) await new Promise(ok => server.close(ok))
    if (hostServer) await new Promise(ok => hostServer.close(ok))
    await service.dispose(); await store.dispose()
    // Exact owned mkdtemp directory, never workspace storage.
    assert.ok(directory.startsWith(join(tmpdir(), 'dsh-http-receipt-')))
    await rm(directory, { recursive: true, force: true })
  }
}

import assert from 'node:assert/strict'
import { createServer, connect } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ConnectionService } from '../src/host/connection-service.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { memoryPasswordProtector } from '../src/password-protector.ts'

async function within(promise, timeout, message) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout) })]) }
  finally { clearTimeout(timer) }
}

/** Called only by the owned MySQL/Oracle acceptance fixtures; no arbitrary target CLI. */
export async function checkCommittedReceiptFaults(input, schema, readValue) {
  const checks = []
  for (const [index, mode] of ['cut', 'cancel', 'timeout'].entries()) {
    console.log(`receipt-fault: ${input.dialect} ${mode}`)
    const directory = await mkdtemp(join(tmpdir(), 'dsh-receipt-fault-'))
    const executions = new ExecutionStore(directory)
    const service = new ConnectionService(() => true, directory, undefined, memoryPasswordProtector, executions)
    const sockets = new Set()
    let armed = false, blocked = false, confirmed
    const marker = 201 + index
    const committed = new Promise(resolve => { confirmed = resolve })
    const proxy = createServer(client => {
      const upstream = connect({ host: input.host, port: input.port })
      for (const socket of [client, upstream]) { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)) }
      client.pipe(upstream)
      let forwarding = Promise.resolve()
      upstream.on('data', chunk => {
        forwarding = forwarding.then(async () => {
          if (blocked || client.destroyed) return
          // Observe the actual commit using a separate direct database session before withholding its receipt.
          if (armed && Number(await readValue()) === marker) { blocked = true; confirmed(); return }
          client.write(chunk)
        }).catch(error => client.destroy(error))
      })
      upstream.on('end', () => { void forwarding.then(() => { if (!blocked) client.end() }) })
      client.on('close', () => upstream.destroy())
    })
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
    try {
      const connection = await service.open('fault', { ...input, port: proxy.address().port, environment: 'sit' }, false)
      await service.catalog('fault', connection.id, connection.generation, { kind: 'schemas', search: schema })
      const before = Number(await readValue(2))
      const sql = `UPDATE row_limit SET value=value+1 WHERE id=2; UPDATE row_limit SET value=${marker} WHERE id=1; UPDATE row_limit SET value=999 WHERE id=1`
      let document = service.getExecutionDocument('fault', connection.id)
      document = service.updateExecutionDocument('fault', connection.id, sql, 'user', document.revision, connection.generation, { schema })
      // Pre-dispatch cancellation must not reach the proxy or mutate either row.
      const previousIds = new Set(executions.list('fault').map(row => row.executionId))
      const cancelled = new AbortController(); cancelled.abort()
      await assert.rejects(service.runExecutionDocument('fault', connection.id, connection.generation, document.revision, cancelled.signal))
      assert.ok(executions.list('fault').filter(row => !previousIds.has(row.executionId)).every(row => !row.events.some(event => event.kind === 'dispatched')), 'pre-dispatch abort must not send a Worker request')
      assert.equal(Number(await readValue(2)), before)
      armed = true
      const outcome = service.runExecutionDocument('fault', connection.id, connection.generation, document.revision).then(value => ({ value }), error => ({ error }))
      await within(committed, 15000, 'independent commit observation timed out')
      assert.equal(Number(await readValue()), marker)
      if (mode === 'cut') for (const socket of sockets) socket.destroy()
      if (mode === 'cancel') {
        const row = executions.list('fault').find(row => row.status === 'running')
        assert.ok(row); executions.cancel('fault', row.executionId, true)
      }
      const settled = await within(outcome, 40000, 'unknown receipt did not settle')
      assert.ok(settled.error, 'lost commit receipt must not report success')
      assert.equal(settled.error.executionStatus, 'unknown')
      const record = executions.get('fault', settled.error.executionId, true)
      assert.equal(record.status, 'unknown')
      assert.deepEqual(record.result?.steps?.map(step => step.status), ['succeeded', 'unknown', 'not-run'])
      await delay(250)
      assert.equal(Number(await readValue()), marker, 'the unexecuted third statement and automatic replay must remain absent')
      assert.equal(Number(await readValue(2)), before + 1, 'the committed first statement must execute exactly once')
      checks.push(`${mode}: independent commit, unknown receipt, committed prefix, no replay; pre-dispatch abort had no effect`)
    } finally {
      for (const socket of sockets) socket.destroy()
      await service.dispose(); await executions.dispose()
      await new Promise(resolve => proxy.close(resolve))
      await rm(directory, { recursive: true, force: true })
    }
  }
  return `Committed TCP receipt faults: ${checks.join('; ')}`
}

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { chromium } from 'playwright'

// Test-only HTTP tool route, actual service and public workspace, controlled Worker replies.
const root = resolve('artifacts/ui/redis-read')
await mkdir(root, { recursive: true })
const run = await mkdtemp(join(root, 'run-'))
await build({ stdin: { resolveDir: resolve('.'), loader: 'ts', contents: `
  export { ConnectionService } from './src/host/connection-service.ts'
  export { ExecutionStore } from './src/host/execution-store.ts'
  export { connectionApi } from './src/host/connection-api.ts'
  export { registerRedisAiTools } from './src/host/redis-ai-tools.ts'
` }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: join(run, 'host.mjs') })
await build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
  import React, { useState } from 'react'
  import { createRoot } from 'react-dom/client'
  import { connectionBridge } from './src/client/connection-bridge.ts'
  import { StandardSourceMount } from './src/client/workspace-sources.tsx'
  import { clientModules } from './src/client/data-sources/registry.ts'
  import './src/client/style.css'
  const host = connectionBridge('owner', { mode: 'host', connections: [], tables: () => [], execute: async () => ({}) })
  const connection = await host.connect({ dialect: 'redis', name: '读取测试', environment: 'sit', host: '127.0.0.1', port: 6379, username: '', password: '', database: '0' })
  window.fixture = { host, connection }
  function App() {
    const [database, setDatabase] = useState('0')
    window.fixture.switchDb = setDatabase
    return <div className="db-workbench"><StandardSourceMount module={clientModules.get('redis')} context={{ host, connection, catalogRoot: database, refreshToken: 0 }} /></div>
  }
  createRoot(document.getElementById('app')).render(<App />)
` }, bundle: true, format: 'esm', outdir: run, entryNames: 'fixture' })
await writeFile(join(run, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>html,body,#app,.db-workbench{height:100%;margin:0}</style><div id="app"></div><script type="module" src="/fixture.js"></script>')
const { ConnectionService, ExecutionStore, connectionApi, registerRedisAiTools } = await import(pathToFileURL(join(run, 'host.mjs')).href)
const executions = new ExecutionStore(join(run, 'state'))
const marker = join(run, 'dispatch.jsonl')
const service = new ConnectionService(id => id === 'owner', join(run, 'state'), undefined, undefined, executions, undefined,
  () => new Worker(pathToFileURL(resolve('test/fixtures/redis-queue-worker.mjs')), { workerData: { marker } }))
const tools = new Map()
registerRedisAiTools({ tools: { register: tool => tools.set(tool.name, tool) } }, service, executions, id => id === 'owner')
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://fixture').pathname
  if (path === '/plugins/database/connections' || path === '/fixture-read') {
    if (req.headers.cookie !== 'redis-read-fixture=1') { res.writeHead(401); res.end(); return }
    if (path === '/plugins/database/connections') { await connectionApi(service, executions, 'owner', req, res); return }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const controller = new AbortController()
    const abort = () => { if (!res.writableEnded) controller.abort() }
    res.once('close', abort)
    try {
      const { name, args } = JSON.parse(Buffer.concat(chunks))
      if (!['redis_keys', 'redis_value'].includes(name)) throw new Error('fixture only permits read tools')
      const body = JSON.parse(await tools.get(name).execute(args, { agent: { session: { id: 'owner' } }, callId: 'browser-read', rootCallId: 'browser-root', signal: controller.signal }))
      if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    } catch (error) { if (!res.destroyed) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })) } }
    finally { res.off('close', abort) }
    return
  }
  const file = path === '/fixture.js' ? 'fixture.js' : path === '/fixture.css' ? 'fixture.css' : 'index.html'
  res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html')
  res.end(await readFile(join(run, file)))
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
const read = (name, input) => page.evaluate(async ({ name, input }) => {
  const c = window.fixture.connection
  const reply = await fetch('/fixture-read', { method: 'POST', body: JSON.stringify({ name, args: { connectionId: c.id, generation: c.generation, ...input } }) })
  return { status: reply.status, body: await reply.json() }
}, { name, input })
try {
  assert.equal((await fetch(origin + '/plugins/database/connections')).status, 401)
  await page.context().addCookies([{ name: 'redis-read-fixture', value: '1', url: origin }])
  await page.goto(origin)
  await page.getByRole('tab', { name: 'AI Query' }).click()
  assert.equal((await read('redis_keys', {})).status, 200)
  assert.equal((await read('redis_value', { key: 'fixture:key' })).status, 200)
  await page.locator('.db-ai-item-main').filter({ hasText: 'Redis SCAN' }).first().waitFor()
  assert.equal(await page.getByLabel('Redis 命令').textContent(), '', 'read tools do not publish editor text')
  await page.getByLabel('Redis 命令').fill('PING')
  await page.waitForFunction(async () => (await window.fixture.host.executions('execution-document-get', { id: window.fixture.connection.id })).document.controller === 'user')
  assert.equal((await read('redis_keys', {})).status, 400)
  await page.getByRole('button', { name: '归还 AI', exact: true }).click()
  await page.waitForFunction(async () => (await window.fixture.host.executions('execution-document-get', { id: window.fixture.connection.id })).document.controller === 'ai')
  const pending = read('redis_keys', { match: 'fixture:delay' })
  await page.waitForFunction(async () => (await window.fixture.host.executions('execution-list', {})).items.some(item => item.operation === 'redis_keys' && item.status === 'running'))
  await page.evaluate(() => window.fixture.switchDb('2'))
  await page.waitForFunction(async () => (await window.fixture.host.executions('execution-document-get', { id: window.fixture.connection.id })).document.context.database === '2')
  assert.equal((await pending).status, 200, 'already dispatched read can finish its own history after a target switch')
  assert.equal(await page.getByLabel('Redis 命令').textContent(), 'PING')
  await read('redis_keys', {})
  const hanging = read('redis_keys', { match: 'fixture:hang' })
  await page.waitForFunction(async () => (await window.fixture.host.executions('execution-list', {})).items.some(item => item.operation === 'redis_keys' && item.status === 'running'))
  await page.locator('.db-ai-item-main').filter({ hasText: '执行中' }).first().click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal((await hanging).status, 400)
  await page.getByLabel('执行详情').getByText('结果未知', { exact: true }).waitFor()
  const items = executions.list('owner')
  assert.ok(items.every(item => item.events.filter(event => event.kind === 'dispatched').length === 1))
  assert.ok(items.every(item => item.type === 'tool' && item.callId === 'browser-read' && item.rootCallId === 'browser-root'))
  assert.ok(!(await readFile(join(run, 'state', 'ai-executions.json'), 'utf8')).includes('SECRET_PAYLOAD'))
  assert.deepEqual(errors, [])
  const report = { status: 'PASS', evidence: 'controlled Worker, real service/tool registration/public workspace', checks: ['authenticated reads', 'read history', 'takeover/return', 'DB switch and late reply', 'cancel from history', 'editor text preserved', 'safe history'], pageErrors: errors }
  await writeFile(join(run, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally {
  await page.close(); await browser.close(); await service.dispose(); executions.dispose()
  await new Promise(done => server.close(done))
}

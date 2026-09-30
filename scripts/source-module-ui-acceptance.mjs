import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { sourceFixtureRegistrations } from './source-fixture-registrations.mjs'

const root = resolve('artifacts/ui/source-module')
await mkdir(root, { recursive: true })
const run = await mkdtemp(join(root, 'run-'))
await build({ stdin: { contents: "export { registerDatabase } from './src/host/register.ts'", resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: join(run, 'host.mjs'), plugins: [sourceFixtureRegistrations()] })
await build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
  import React from 'react'
  import { createRoot } from 'react-dom/client'
  import { connectionBridge } from './src/client/connection-bridge.ts'
  import { StandardSourceMount } from './src/client/workspace-sources.tsx'
  import { clientModules } from './src/client/data-sources/registry.ts'
  import './src/client/style.css'
  const host = connectionBridge('owner', { mode: 'host', connections: [], tables: () => [], execute: async () => ({}) })
  const connection = await host.connect({ dialect: 'mock-source', name: '模拟连接', environment: 'sit', host: 'fixture', port: 1, username: '', password: '', database: '' })
  window.fixture = { host, connection }
  createRoot(document.getElementById('app')).render(<div className="db-workbench"><StandardSourceMount module={clientModules.get('mock-source')} context={{ host, connection }} /></div>)
` }, bundle: true, format: 'esm', outdir: run, entryNames: 'fixture', plugins: [sourceFixtureRegistrations()] })
await writeFile(join(run, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>html,body,#app,.db-workbench{height:100%;margin:0}</style><div id="app"></div><script type="module" src="/fixture.js"></script>')
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = join(run, 'home')
const routes = new Map(), tools = new Map()
const { registerDatabase } = await import(pathToFileURL(join(run, 'host.mjs')).href)
const registration = registerDatabase({
  sessions: { get: id => id === 'owner' ? { id } : undefined },
  connection: { requestRejection: req => req.headers.cookie === 'dsh-fixture=1' ? undefined : 401 },
  webServer: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } },
  tools: { register: tool => tools.set(tool.name, tool) }, on: () => () => {},
}, pathToFileURL(resolve('test/fixtures/source-module-worker.mjs')))
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://fixture').pathname
  if (routes.has(path)) { routes.get(path).handler(req, res); return }
  if (path === '/fixture-ai') {
    if (req.headers.cookie !== 'dsh-fixture=1') { res.writeHead(401); res.end(); return }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    try {
      const args = JSON.parse(Buffer.concat(chunks))
      const result = await tools.get('mock_read').execute(args, { agent: { session: { id: 'owner' } }, callId: 'fixture-ai-call' })
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result))
    } catch (error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })) }
    return
  }
  const file = path === '/fixture.js' ? 'fixture.js' : path === '/fixture.css' ? 'fixture.css' : 'index.html'
  res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html')
  res.end(await readFile(join(run, file)))
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
try {
  assert.equal((await fetch(`${origin}/plugins/database/connections?conversationId=owner`)).status, 401)
  await page.context().addCookies([{ name: 'dsh-fixture', value: '1', url: origin }])
  await page.goto(origin)
  await page.getByRole('button', { name: '查询对象 item' }).click()
  await assert.rejects(page.evaluate(async () => window.fixture.host.executeText(window.fixture.connection, 'READ item', { unexpected: 'target' })))
  await page.getByRole('button', { name: '执行', exact: true }).first().click()
  await page.getByText('模拟读取完成', { exact: true }).waitFor()
  const records = () => page.evaluate(async () => window.fixture.host.executions('execution-list', {}))
  assert.equal((await records()).items.length, 1, 'one manual operation creates one main record')
  await page.getByRole('tab', { name: 'AI Query' }).click()
  const ai = text => page.evaluate(async text => {
    const connection = window.fixture.connection
    const response = await fetch('/fixture-ai', { method: 'POST', body: JSON.stringify({ id: connection.id, generation: connection.generation, text }) })
    return { status: response.status, body: await response.json() }
  }, text)
  const executed = await ai('READ item')
  assert.equal(executed.status, 200, JSON.stringify(executed.body))
  assert.ok(executed.body.executionId)
  await page.getByLabel('模拟源操作').fill('READ other')
  await page.waitForFunction(async () => {
    const { host, connection } = window.fixture
    const body = await host.executions('execution-document-get', { id: connection.id, generation: connection.generation })
    return body.document.text === 'READ other' && body.document.controller === 'user'
  })
  assert.equal((await ai('READ item')).status, 400, 'human takeover rejects AI publication')
  await page.getByRole('button', { name: '归还 AI', exact: true }).click()
  await page.waitForFunction(async () => {
    const { host, connection } = window.fixture
    return (await host.executions('execution-document-get', { id: connection.id, generation: connection.generation })).document.controller === 'ai'
  })
  assert.equal((await ai('READ other')).status, 200, 'return-to-AI reuses the same document flow')
  await page.getByRole('tab', { name: '经验库' }).click()
  await page.getByLabel('标题').fill('模拟经验')
  await page.getByLabel('模拟源操作').fill('READ item')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByText('模拟经验', { exact: true }).waitFor()
  const items = await page.evaluate(async () => window.fixture.host.templates('knowledge-search', { connectionId: window.fixture.connection.id, generation: window.fixture.connection.generation }))
  assert.equal(items.items.length, 1)
  assert.equal(items.items[0].sourceId, 'mock-source')
  assert.equal((await records()).items.length, 3, 'knowledge saving and rejected AI publication do not execute')
  await page.getByRole('button', { name: '试运行', exact: true }).click()
  await page.getByText('模拟读取完成', { exact: true }).waitFor()
  assert.equal((await records()).items.length, 4, 'knowledge trial uses normal execution and one record')
  for (const width of [420, 768, 1200]) {
    await page.setViewportSize({ width, height: 760 })
    await page.getByRole('tab', { name: '查询', exact: true }).click()
    await page.getByLabel('模拟源操作').fill('READ item')
    await page.getByRole('button', { name: '执行', exact: true }).first().click()
    await page.getByText('模拟读取完成', { exact: true }).waitFor()
  }
  assert.deepEqual(errors, [])
  const report = { status: 'PASS', fixture: 'test-only-source', registrationOnly: true, checks: ['authenticated HTTP', 'real ConnectionService and Worker', 'public standard mount', 'single record', 'AI document and takeover', 'knowledge persistence', '420/768/1200'], pageErrors: errors }
  await writeFile(join(run, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally {
  await browser.close(); await registration.dispose(); await new Promise(done => server.close(done))
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
}

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const directory = resolve('artifacts/ui/tab-results')
await mkdir(directory, { recursive: true })
await build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SourceWorkspace } from './src/client/workspace/source/source-workspace.tsx'
import { ObjectWorkspace } from './src/client/object-workspace.tsx'
import { SqlWorkspaceTab } from './src/client/sql-workspace-tab.tsx'
import { SchemaCache } from './src/client/schema/schema-cache.ts'
import './src/client/style.css'
const probe = window.probe = { calls: [], hold: false, waiting: [] }
const bridge = { mode: 'host', tables: () => [],
  catalog: async (_c, input) => ({ items: [], columns: [{ name: 'id', type: 'int' }], indexes: { values: [] }, kind: 'table' }),
  maintenance: async () => ({ canEnable: false, reason: 'fixture readonly', columns: [], identityColumns: [], primaryKeys: [], resultPrimaryKeys: [] }),
  execute: async (connection, sql, signal) => {
    const call = { sql, generation: connection.generation, signal }; probe.calls.push(call)
    const reply = () => ({ columns: ['id'], rows: [[String(probe.calls.indexOf(call) + 1)]], elapsedMs: 1, truncated: false })
    if (probe.hold) return new Promise(resolve => probe.waiting.push(() => resolve(reply())))
    return reply()
  },
}
const cache = new SchemaCache(bridge)
function App() {
  const [generation, setGeneration] = useState('g1')
  const [sub, setSub] = useState('data')
  const [sql, setSql] = useState('SELECT id FROM demo')
  const [closed, setClosed] = useState(false)
  probe.reconnect = () => setGeneration(value => value === 'g1' ? 'g2' : 'g1')
  probe.close = () => setClosed(true)
  const connection = { id: 'fixture', generation, dialect: new URLSearchParams(location.search).get('source'), live: true, name: 'Fixture', environment: 'sit', database: 'app' }
  return closed ? null : <SourceWorkspace bridge={bridge} connection={connection} sourceName="SQL" pages={{
    initialItems: [{ id: 'home' }, { id: 'object' }, { id: 'sql' }], initialActive: 'object', fallback: 'home', keepMounted: true,
    describe: item => ({ id: item.id, label: { home: '总览', object: '表数据', sql: '查询' }[item.id] }),
    content: (item, active) => item.id === 'object'
      ? <ObjectWorkspace bridge={bridge} connection={connection} schema="app" table="demo" isView={false} sub={sub} cache={cache} active={active} onSub={setSub} onStatus={() => {}} />
      : item.id === 'sql' ? <SqlWorkspaceTab bridge={bridge} connection={connection} schema="app" schemas={['app']} cache={cache} initialSql={sql} tabId="sql" active={active} onSql={setSql} onSchemaChange={() => {}} onSavedExperience={() => {}} onStatus={() => {}} /> : <div>总览内容</div>
  }} />
}
createRoot(document.getElementById('app')).render(<App />)
` }, bundle: true, format: 'esm', outdir: directory, entryNames: 'fixture' })
await writeFile(resolve(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>html,body,#app{height:100%;margin:0}</style><div id="app" class="db-workbench"></div><script type="module" src="/fixture.js"></script>')
const server = createServer(async (request, response) => {
  const file = request.url === '/fixture.js' ? 'fixture.js' : request.url === '/fixture.css' ? 'fixture.css' : 'index.html'
  response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html')
  response.end(await readFile(resolve(directory, file)))
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
let browser
const findings = [], errors = []
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  for (const source of ['mysql', 'oracle']) {
    const page = await browser.newPage()
    page.setDefaultTimeout(6000)
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
    await page.goto(`http://127.0.0.1:${server.address().port}/?source=${source}`)
    const tab = name => page.getByRole('tab', { name, exact: true })
    const calls = () => page.evaluate(() => window.probe.calls.length)
    const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
    await page.waitForFunction(() => window.probe?.calls.length === 1)
    await page.getByRole('button', { name: '刷新', exact: true }).waitFor()
    for (let i = 0; i < 3; ++i) { await tab('总览').click(); await tab('表数据').click() }
    await settle()
    assert.equal(await calls(), 1, 'reactivating a table must preserve the fetched result')
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.waitForFunction(() => window.probe.calls.length === 2)
    await page.getByRole('button', { name: '字段', exact: true }).click()
    await page.getByRole('button', { name: '数据', exact: true }).click()
    assert.equal(await calls(), 2, 'table sub-tabs must not rerun the query')
    await page.evaluate(() => { window.probe.hold = true })
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.waitForFunction(() => window.probe.waiting.length === 1)
    await tab('总览').click()
    assert.equal(await page.evaluate(() => window.probe.calls.at(-1).signal.aborted), false, 'hiding a table must not cancel its query')
    await page.evaluate(() => { window.probe.hold = false; window.probe.waiting.shift()() })
    await tab('表数据').click()
    await page.locator('.db-object-tab .db-grid tbody').getByText('3', { exact: true }).waitFor()
    assert.equal(await calls(), 3)
    await tab('查询').click()
    await page.getByRole('button', { name: '运行', exact: true }).first().click()
    await page.locator('.db-sql-tab .db-grid tbody').getByText('4', { exact: true }).waitFor()
    await tab('表数据').click(); await tab('查询').click()
    assert.equal(await calls(), 4, 'SQL tab switches must not replay the query')
    assert.equal(await page.getByText(/的结果仅供查看/).count(), 0, 'visibility must not invalidate SQL execution identity')
    await page.evaluate(() => { window.probe.hold = true })
    await page.getByRole('button', { name: '运行', exact: true }).first().click()
    await page.waitForFunction(() => window.probe.waiting.length === 1)
    await tab('总览').click()
    assert.equal(await page.evaluate(() => window.probe.calls.at(-1).signal.aborted), false, 'hiding SQL must not cancel execution')
    await page.evaluate(() => { window.probe.hold = false; window.probe.waiting.shift()() })
    await tab('查询').click()
    await page.locator('.db-sql-tab .db-grid tbody').getByText('5', { exact: true }).waitFor()
    assert.equal(await calls(), 5)
    await page.evaluate(() => window.probe.reconnect())
    await page.getByText(/的结果仅供查看/).waitFor()
    await tab('表数据').click()
    await page.waitForFunction(() => window.probe.calls.length === 6)
    await page.evaluate(() => { window.probe.hold = true })
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.waitForFunction(() => window.probe.waiting.length === 1)
    await page.evaluate(() => window.probe.close())
    await settle()
    assert.equal(await page.evaluate(() => window.probe.calls.at(-1).signal.aborted), true, 'closing still cancels owned work')
    findings.push({ source, status: 'PASS', checks: ['table tab preservation', 'explicit refresh', 'table sub-tabs', 'hidden table completion', 'SQL result identity', 'hidden SQL completion', 'generation invalidation', 'unmount cancellation'] })
    await page.close()
  }
  assert.deepEqual(errors, [])
  await writeFile(resolve(directory, 'acceptance.json'), JSON.stringify({ status: 'PASS', findings, errors }, null, 2))
  console.log(JSON.stringify({ status: 'PASS', findings }))
} finally {
  await browser?.close()
  await new Promise(done => server.close(done))
}

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
const directory = resolve('artifacts/fact-adoption')
await mkdir(directory, { recursive: true })
await build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useExecutionDocument } from './src/client/workspace/source/use-execution-document.ts'
import { useDocumentResultBus } from './src/client/ai-query-bus.ts'
import { updateExecutionDocument, controlExecutionDocument } from './src/shared/execution-document.ts'
import { SqlWorkspaceTab } from './src/client/sql-workspace-tab.tsx'
import { SchemaCache } from './src/client/schema/schema-cache.ts'
import './src/client/style.css'
const mode = new URLSearchParams(location.search).get('mode')
const api = window.probe = { calls: [], maintenanceTargets: [] }
let serverDocument = { sourceId: 'mysql', text: 'SELECT 1', context: { schema: 'app' }, revision: 1, controller: 'user' }
const bridge = { mode: 'host', tables: () => [],
  catalog: async () => ({ items: [{ name: 'app' }, { name: 'other' }], columns: [], indexes: { values: [] } }),
  maintenance: async (_connection, input) => {
    if (input.kind === 'capability') {
      const capability = { id: 'cap', source: 'query', schema: input.schema, table: 'demo', canEnable: true, canUpdate: true, canInsert: false, canDelete: false, reason: '', primaryKeys: ['id'], resultPrimaryKeys: ['id'], identityColumns: [], columns: [{ resultColumn: 'id', sourceColumn: 'id', editable: false }, { resultColumn: 'value', sourceColumn: 'value', editable: true }] }
      if (api.holdCapability) { api.holdCapability = false; return new Promise(resolve => { api.releaseCapability = () => resolve(capability) }) }
      return capability
    }
    if (input.kind === 'enable') return { enabled: input.enabled }
    if (input.kind === 'preview') { api.maintenanceTargets.push(input.schema); return { id: 'p', sql: 'UPDATE demo SET value=? WHERE id=?', params: [input.operation.values.value, input.operation.original.id] } }
    if (input.kind === 'execute') return { status: 'success' }
    return {}
  },
  execute: async (connection, sql) => { api.calls.push({ target: connection.database, sql }); return new Promise(resolve => { api.releaseQuery = () => resolve({ columns: ['id','value'], rows: [['1','old-app-result']], elapsedMs: 1, truncated: false }) }) },
  executions: async (action, body, signal) => {
    if (action === 'execution-wait') return new Promise((resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    if (action === 'execution-document-get') { const snapshot = structuredClone(serverDocument); if (api.holdGet) { api.holdGet = false; return new Promise(resolve => { api.releaseGet = () => resolve({ document: snapshot }) }) }; return { document: snapshot } }
    if (action === 'execution-document-update') { if (api.failSave) { api.failSave = false; throw new Error('fixture save failed') }; serverDocument = updateExecutionDocument(serverDocument, body.text, 'user', body.revision, body.context); return { document: structuredClone(serverDocument) } }
    if (action === 'execution-document-control') { serverDocument = controlExecutionDocument(serverDocument, body.controller); return { document: structuredClone(serverDocument) } }
    if (action === 'execution-document-run') return { executionId: 'run', status: 'succeeded', result: { columns: [], rows: [], truncated: false, elapsedMs: 1 } }
    if (action === 'execution-latest') { if (api.holdLatest) { api.holdLatest = false; const snapshot = structuredClone(api.latest); return new Promise(resolve => { api.releaseLatest = () => resolve({ execution: snapshot }) }) }; return {} }
    return {}
  }
}
const cache = new SchemaCache(bridge.catalog, { prewarmTableLimit: 0 })
const base = { id: 'fixture', name: 'Fixture', dialect: 'mysql', environment: 'sit', live: true }
function HookApp() {
  const [generation, setGeneration] = useState('g1')
  const document = useExecutionDocument(bridge, { ...base, generation })
  api.document = document; api.reconnect = () => setGeneration('g2'); api.server = () => serverDocument; api.replaceServer = value => { serverDocument = value }
  return <pre id="state">{JSON.stringify({ text: document.text, revision: document.document.revision, unsaved: document.unsaved, busy: document.busy, error: document.error })}</pre>
}
function BusApp() {
  const [query, setQuery] = useState({ sql: 'SELECT 1', schema: 'app', revision: 1, controller: 'user' })
  const bus = useDocumentResultBus({ bridge, connection: { ...base, generation: 'g1' }, document: { sourceId: 'mysql', text: query.sql, context: { schema: query.schema }, revision: query.revision, controller: query.controller } })
  api.bus = bus; api.setQuery = setQuery; api.query = query
  return <pre id="state">{JSON.stringify({ query, display: bus.display })}</pre>
}
function GridApp() {
  const [schema, setSchema] = useState('app')
  const [generation, setGeneration] = useState('g1')
  api.setSchema = setSchema; api.schema = schema; api.generation = generation; api.reconnect = () => setGeneration('g2')
  return <SqlWorkspaceTab bridge={bridge} connection={{ ...base, generation }} schema={schema} schemas={['app','other']} cache={cache} initialSql="SELECT id,value FROM demo" onSchemaChange={setSchema} onSql={() => {}} onStatus={() => {}} onSavedExperience={() => {}} />
}
createRoot(document.getElementById('app')).render(mode === 'bus' ? <BusApp /> : mode === 'grid' ? <GridApp /> : <HookApp />)
` }, bundle: true, format: 'esm', outdir: directory, entryNames: 'probe' })
await writeFile(resolve(directory, 'index.html'), '<html><head><meta charset="utf-8"><link rel="stylesheet" href="/probe.css"><style>html,body,#app{height:100%;margin:0}</style></head><body><div id="app" class="db-workbench"></div><script type="module" src="/probe.js"></script></body></html>')
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://fixture').pathname
  try { response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html'); response.end(await readFile(resolve(directory, '.' + (path === '/' ? '/index.html' : path)))) }
  catch { response.writeHead(404); response.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const findings = [], errors = []
async function page(mode) { const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto('http://127.0.0.1:' + server.address().port + '/?mode=' + mode); await page.waitForFunction(() => window.probe); return page }
try {
  let current = await page('hook'); await current.waitForFunction(() => window.probe.document.text === 'SELECT 1')
  await current.evaluate(() => { window.probe.holdGet = true; void window.probe.document.load() }); await current.waitForFunction(() => window.probe.releaseGet)
  await current.evaluate(() => window.probe.document.edit('SELECT 2', { schema: 'other' })); await current.waitForFunction(() => window.probe.server().text === 'SELECT 2' && !window.probe.document.unsaved)
  await current.evaluate(() => window.probe.releaseGet()); await current.waitForFunction(() => window.probe.document.text === 'SELECT 2' && window.probe.document.document.revision === 2)
  findings.push({ id: 'late-document', status: 'PASS', observed: await current.evaluate(() => ({ local: window.probe.document.document, authoritative: window.probe.server() })) }); await current.close()

  current = await page('hook'); await current.waitForFunction(() => window.probe.document.text === 'SELECT 1')
  await current.evaluate(() => { window.probe.holdGet = true; void window.probe.document.load() }); await current.waitForFunction(() => window.probe.releaseGet)
  await current.evaluate(() => { window.probe.releaseOld = window.probe.releaseGet; window.probe.replaceServer({ ...window.probe.server(), text: 'SELECT remote', revision: 2 }); void window.probe.document.load() })
  await current.waitForFunction(() => window.probe.document.document.revision === 2)
  await current.evaluate(() => window.probe.releaseOld()); await current.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await current.evaluate(() => window.probe.document.text), 'SELECT remote')
  assert.equal(await current.evaluate(() => window.probe.document.document.revision), 2)
  findings.push({ id: 'two-reads-out-of-order', status: 'PASS' }); await current.close()

  current = await page('hook'); await current.waitForFunction(() => window.probe.document.text === 'SELECT 1')
  await current.evaluate(() => { window.probe.failSave = true; window.probe.document.edit('SELECT unsaved') }); await current.waitForFunction(() => window.probe.document.error.includes('save failed'))
  await current.evaluate(() => window.probe.document.run())
  const afterRun = await current.evaluate(() => ({ error: window.probe.document.error, unsaved: window.probe.document.unsaved })); assert.match(afterRun.error, /save failed/); assert.equal(afterRun.unsaved, true)
  findings.push({ id: 'hidden-save-error', status: 'PASS', observed: afterRun })
  await current.evaluate(() => window.probe.reconnect()); await current.waitForFunction(() => window.probe.document.text === 'SELECT unsaved' && window.probe.document.unsaved)
  findings.push({ id: 'reconnect-draft-loss', status: 'PASS', observed: await current.evaluate(() => ({ text: window.probe.document.text, unsaved: window.probe.document.unsaved })) })
  await current.evaluate(() => window.probe.document.retrySave())
  await current.waitForFunction(() => !window.probe.document.unsaved && window.probe.server().text === 'SELECT unsaved')
  assert.equal(await current.evaluate(() => window.probe.document.error), '')
  findings.push({ id: 'reconnect-explicit-save-retry', status: 'PASS' }); await current.close()

  current = await page('bus'); await current.waitForFunction(() => window.probe.bus)
  await current.evaluate(() => { window.probe.latest = { identity: { conversationId: 'fact', connectionId: 'fixture', sourceId: 'mysql', generation: 'g1', queryRevision: 1, context: { schema: 'app' }, executedSql: 'SELECT 1', documentText: 'SELECT 1', initiator: 'user' }, executionId: 'old-run', connectionId: 'fixture', generation: 'g1', queryRevision: 1, schema: 'app', executedSql: 'SELECT 1', documentText: 'SELECT 1', initiator: 'user', type: 'query', result: { columns: ['value'], rows: [['old']], truncated: false, elapsedMs: 1 } }; window.probe.holdLatest = true; void window.probe.bus.hydrate() }); await current.waitForFunction(() => window.probe.releaseLatest)
  await current.evaluate(() => window.probe.setQuery({ sql: 'SELECT 2', schema: 'other', revision: 2, controller: 'user' })); await current.waitForFunction(() => window.probe.query.revision === 2)
  await current.evaluate(() => window.probe.releaseLatest()); await current.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); assert.equal(await current.evaluate(() => window.probe.bus.display?.executionId), undefined)
  findings.push({ id: 'late-result-hydrate', status: 'PASS', observed: await current.evaluate(() => ({ query: window.probe.query, display: window.probe.bus.display })) }); await current.close()

  current = await page('bus'); await current.waitForFunction(() => window.probe.bus)
  await current.evaluate(() => {
    const identity = { conversationId: 'fact', connectionId: 'fixture', sourceId: 'mysql', generation: 'g1', queryRevision: 1, context: { schema: 'app' }, executedSql: 'SELECT 1', documentText: 'SELECT 1', initiator: 'user' }
    const result = { columns: ['value'], rows: [['old']], truncated: false, elapsedMs: 1 }
    window.probe.latest = { identity, executionId: 'old', result, type: 'query' }
    window.probe.holdLatest = true; void window.probe.bus.hydrate()
  }); await current.waitForFunction(() => window.probe.releaseLatest)
  await current.evaluate(() => {
    const identity = window.probe.latest.identity
    window.probe.bus.accept({ identity, executionId: 'new', result: { columns: ['value'], rows: [['new']], truncated: false, elapsedMs: 1 } })
  }); await current.waitForFunction(() => window.probe.bus.display?.executionId === 'new')
  await current.evaluate(() => window.probe.releaseLatest()); await current.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await current.evaluate(() => window.probe.bus.display.executionId), 'new')
  await current.evaluate(() => window.probe.bus.accept({ identity: window.probe.latest.identity, executionId: 'invalid', result: null }))
  assert.equal(await current.evaluate(() => window.probe.bus.display.executionId), 'new')
  findings.push({ id: 'same-document-old-recovery-cannot-replace-live-result', status: 'PASS' }); await current.close()

  current = await page('grid'); await current.getByRole('button', { name: '运行', exact: true }).first().click(); await current.waitForFunction(() => window.probe.releaseQuery)
  await current.evaluate(() => window.probe.setSchema('other')); await current.waitForFunction(() => window.probe.schema === 'other')
  await current.evaluate(() => window.probe.releaseQuery()); await current.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await current.getByText('old-app-result', { exact: true }).count(), 0)
  assert.equal(await current.evaluate(() => window.probe.maintenanceTargets.length), 0)
  findings.push({ id: 'manual-grid-late-target', status: 'PASS' }); await current.close()

  for (const change of ['target', 'generation']) {
    current = await page('grid')
    await current.evaluate(() => { window.probe.holdCapability = true })
    await current.getByRole('button', { name: '运行', exact: true }).first().click(); await current.waitForFunction(() => window.probe.releaseQuery)
    await current.evaluate(() => window.probe.releaseQuery()); await current.waitForFunction(() => window.probe.releaseCapability)
    await current.evaluate(change => change === 'target' ? window.probe.setSchema('other') : window.probe.reconnect(), change)
    await current.waitForFunction(change => change === 'target' ? window.probe.schema === 'other' : window.probe.generation === 'g2', change)
    await current.evaluate(() => window.probe.releaseCapability()); await current.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const enable = current.getByRole('button', { name: '开启维护', exact: true })
    assert.ok(await enable.count() === 0 || await enable.isDisabled())
    assert.equal(await current.evaluate(() => window.probe.maintenanceTargets.length), 0)
    findings.push({ id: 'manual-grid-late-capability-' + change, status: 'PASS' }); await current.close()
  }

  current = await page('grid'); await current.getByRole('button', { name: '运行', exact: true }).first().click(); await current.waitForFunction(() => window.probe.releaseQuery)
  await current.evaluate(() => window.probe.reconnect()); await current.waitForFunction(() => window.probe.generation === 'g2')
  await current.evaluate(() => window.probe.releaseQuery()); await current.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await current.getByText('old-app-result', { exact: true }).count(), 0)
  findings.push({ id: 'manual-grid-late-generation', status: 'PASS' }); await current.close()

  current = await page('grid'); await current.getByRole('button', { name: '运行', exact: true }).first().click(); await current.waitForFunction(() => window.probe.releaseQuery)
  await current.evaluate(() => window.probe.releaseQuery()); await current.getByText('old-app-result', { exact: true }).first().waitFor()
  await current.getByRole('button', { name: '开启维护', exact: true }).click()
  await current.locator('td[data-row="0"][data-col="1"]').dblclick(); await current.getByLabel('编辑 value', { exact: true }).fill('changed'); await current.getByLabel('编辑 value', { exact: true }).press('Enter')
  await current.evaluate(() => window.probe.setSchema('other'))
  await current.getByText(/原目标 app 的结果仅供查看/).waitFor()
  assert.equal(await current.getByRole('button', { name: '保存修改', exact: true }).isDisabled(), true)
  assert.equal(await current.evaluate(() => window.probe.maintenanceTargets.length), 0)
  await current.evaluate(() => window.probe.setSchema('app'))
  assert.equal(await current.getByRole('button', { name: '保存修改', exact: true }).isDisabled(), true)
  findings.push({ id: 'manual-grid-frozen-draft', status: 'PASS' }); await current.close()

  assert.deepEqual(errors, [])
  const report = { scope: 'production hooks/components, controlled delayed replies; no database', findings, pageErrors: errors }
  await writeFile(resolve(directory, 'browser-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { ConnectionService } from '../src/host/connection-service.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { connectionApi } from '../src/host/connection-api.ts'
import { hostModules } from '../src/host/data-sources/modules.ts'
import { temporaryDirectory, connectionInput } from '../test/helpers.mjs'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
const directory = resolve('artifacts/execution-boundary')
await mkdir(directory, { recursive: true })
const hostStorage = temporaryDirectory('functional-chain-')
const executions = new ExecutionStore(hostStorage.directory)
const service = new ConnectionService(() => true, hostStorage.directory, undefined, undefined, executions, undefined, url => {
  const kind = url.pathname.includes('redis-worker') ? 'redis' : url.pathname.includes('kafka-worker') ? 'kafka' : 'sql-operation'
  return new Worker(new URL('../test/fixtures/' + (kind === 'sql-operation' ? 'sql-operation' : kind + '-queue') + '-worker.mjs', import.meta.url), { workerData: { marker: resolve(hostStorage.directory, 'sent.jsonl') } })
})
const hostConnections = {}, tools = new Map()
for (const source of ['mysql', 'oracle', 'redis', 'kafka']) {
  const input = source === 'kafka' ? { name: 'Kafka fixture', dialect: source, brokers: ['broker.test:9092'], saslMechanism: 'none', environment: 'sit' }
    : connectionInput({ dialect: source, ...(source === 'redis' ? { port: 6379, database: '0' } : {}) })
  hostConnections[source] = await service.open('owner', input, false)
  hostModules.get(source).ai.register({ tools: { register: tool => tools.set(tool.name, tool) } }, service, executions, () => true, [])
}

await build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
import React, { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { useExecutionDocument } from './src/client/workspace/source/use-execution-document.ts'
import { useDocumentResultBus } from './src/client/ai-query-bus.ts'
import { updateExecutionDocument, controlExecutionDocument } from './src/shared/execution-document.ts'
import { connectionBridge } from './src/client/connection-bridge.ts'
import { ExecutionWorkbench } from './src/client/workspace/source/execution-workbench.tsx'
import { ReadonlyResultGrid } from './src/client/results.tsx'
import { RedisResultView } from './src/client/redis/result.tsx'
import { KafkaResultView } from './src/client/kafka/results.tsx'
import { SqlWorkspaceTab } from './src/client/sql-workspace-tab.tsx'
import { SchemaCache } from './src/client/schema/schema-cache.ts'
import { SqlEditor } from './src/client/editor.tsx'
import { RedisCommandEditor } from './src/client/redis/command-editor.tsx'
import { KafkaCommandEditor } from './src/client/kafka/editor.tsx'
import './src/client/style.css'
const mode = new URLSearchParams(location.search).get('mode')
const api = window.probe = { calls: [], maintenanceTargets: [] }
let serverDocument = { sourceId: mode === 'redis' ? 'redis' : 'kafka', text: 'TOPICS', context: {}, revision: 1, controller: 'user' }
const bridge = { mode: 'host', tables: () => [],
  catalog: async () => ({ items: [{ name: 'app' }, { name: 'other' }], columns: [], indexes: { values: [] } }),
  maintenance: async (_connection, input) => {
    if (input.kind === 'capability') {
      const capability = { id: 'cap', source: 'query', schema: input.schema, table: 'demo', canEnable: true, canUpdate: true, canInsert: false, canDelete: false, reason: '', primaryKeys: ['id'], resultPrimaryKeys: ['id'], identityColumns: [], columns: [{ resultColumn: 'id', sourceColumn: 'id', editable: false }, { resultColumn: 'value', sourceColumn: 'value', editable: true }] }
      if (api.holdCapability) { api.holdCapability = false; return new Promise(resolve => { api.releaseCapability = () => resolve(capability) }) }
      return capability
    }
    if (input.kind === 'enable') return { enabled: input.enabled }
    if (input.kind === 'preview' && api.holdPreview) { api.holdPreview = false; return new Promise(resolve => { api.releasePreview = () => resolve({ id: 'late-preview', sql: 'UPDATE app.demo SET value=? WHERE id=?', params: ['changed', '1'] }) }) }
    if (input.kind === 'preview') { api.maintenanceTargets.push(input.schema); return { id: 'p', sql: 'UPDATE demo SET value=? WHERE id=?', params: [input.operation.values.value, input.operation.original.id] } }
    if (input.kind === 'execute') { api.writeCalls = (api.writeCalls || 0) + 1; return { status: 'success' } }
    return {}
  },
  execute: async (connection, sql) => { api.calls.push({ target: connection.database, sql }); if (api.failQuery) { api.failQuery = false; throw Object.assign(new Error('fixture database rejection'), { effect: 'none' }) }; return new Promise(resolve => { api.releaseQuery = () => resolve({ columns: ['id','value'], rows: [['1','old-app-result']], elapsedMs: 1, truncated: false }) }) },
  executions: async (action, body, signal) => {
    if (action === 'execution-wait') return new Promise((resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    if (action === 'execution-document-get') { const snapshot = structuredClone(serverDocument); if (api.holdGet) { api.holdGet = false; return new Promise(resolve => { api.releaseGet = () => resolve({ document: snapshot }) }) }; return { document: snapshot } }
    if (action === 'execution-document-update') { if (api.failSave) { api.failSave = false; throw new Error('fixture save failed') }; serverDocument = updateExecutionDocument(serverDocument, body.text, 'user', body.revision, body.context); return { document: structuredClone(serverDocument) } }
    if (action === 'execution-document-control') { serverDocument = controlExecutionDocument(serverDocument, body.controller); return { document: structuredClone(serverDocument) } }
    if (action === 'execution-document-run') return { identity: { conversationId: 'fixture-session', sourceId: serverDocument.sourceId, connectionId: 'fixture', generation: body.generation, queryRevision: serverDocument.revision, context: serverDocument.context, documentText: serverDocument.text, executedSql: serverDocument.text, initiator: 'user' }, executionId: 'run', connectionId: 'fixture', generation: body.generation, queryRevision: serverDocument.revision, context: serverDocument.context, documentText: serverDocument.text, executedSql: serverDocument.text, initiator: 'user', status: 'succeeded', result: { columns: ['value'], rows: [['old-result']], truncated: false, elapsedMs: 1 } }
    if (action === 'execution-latest') { if (api.holdLatest) { api.holdLatest = false; const snapshot = structuredClone(api.latest); return new Promise(resolve => { api.releaseLatest = () => resolve({ execution: snapshot }) }) }; return {} }
    return {}
  }
}
const cache = new SchemaCache(bridge.catalog, { prewarmTableLimit: 0 })
const base = { id: 'fixture', name: 'Fixture', dialect: 'mysql', environment: 'sit', live: true }
function HookApp() {
  const [generation, setGeneration] = useState('g1')
  const document = useExecutionDocument(bridge, { ...base, dialect: mode === 'redis' ? 'redis' : 'kafka', generation })
  const results = useDocumentResultBus({ bridge, connection: { ...base, dialect: mode === 'redis' ? 'redis' : 'kafka', generation }, document: document.document, unsaved: document.unsaved }); api.results = results; api.run = async () => results.accept(await document.run());
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
  return <SqlWorkspaceTab bridge={bridge} connection={{ ...base, generation }} schema={schema} schemas={['app']} cache={cache} initialSql={mode === 'grid-write' ? 'UPDATE demo SET value=1 WHERE id=1' : 'SELECT id,value FROM demo'} onSchemaChange={setSchema} onSql={() => {}} onStatus={() => {}} onSavedExperience={() => {}} />
}
const hostBridge = connectionBridge('owner', { mode: 'host', connections: [], tables: () => [], execute: async () => ({}) })
function HostChain({ connection }) {
  const doc = useExecutionDocument(hostBridge, connection)
  const bus = useDocumentResultBus({ bridge: hostBridge, connection, document: doc.document, unsaved: doc.unsaved })
  api.document = doc; api.results = bus; api.connection = connection
  const onChange = text => { api.userEdits = (api.userEdits || 0) + 1; doc.edit(text) }
  const editor = connection.dialect === 'redis' ? <RedisCommandEditor value={doc.text} onChange={onChange} onRun={() => {}} onCursorChange={() => {}} />
    : connection.dialect === 'kafka' ? <KafkaCommandEditor value={doc.text} onChange={onChange} onRun={() => {}} />
    : <SqlEditor value={doc.text} dialect={connection.dialect} schema={doc.document.context.schema || 'app'} onChange={onChange} onRun={() => {}} />
  return <ExecutionWorkbench className="db-sql-run-workspace" resultKey={bus.current?.executionId} editor={editor}
    result={<>{bus.stale && <p>上次执行结果</p>}{bus.display ? <ReadonlyResultGrid result={bus.display.result} /> : connection.dialect === 'redis' ? <RedisResultView result={bus.current?.result} /> : <KafkaResultView result={bus.current?.result} />}</>} />
}
function HostBootstrap() {
  const [connection, setConnection] = useState()
  useEffect(() => { fetch('/host-bootstrap?source=' + mode.slice(6)).then(response => response.json()).then(setConnection) }, [])
  return connection ? <HostChain connection={connection} /> : null
}
createRoot(document.getElementById('app')).render(mode.startsWith('chain-') ? <HostBootstrap /> : mode === 'bus' ? <BusApp /> : mode.startsWith('grid') ? <GridApp /> : <HookApp />)
` }, bundle: true, format: 'esm', outdir: directory, entryNames: 'probe' })
await writeFile(resolve(directory, 'index.html'), '<html><head><meta charset="utf-8"><link rel="stylesheet" href="/probe.css"><style>html,body,#app{height:100%;margin:0}</style></head><body><div id="app" class="db-workbench"></div><script type="module" src="/probe.js"></script></body></html>')
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture'), path = url.pathname
  if (path === '/plugins/database/connections') return connectionApi(service, executions, 'owner', request, response)
  if (path === '/host-bootstrap') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(hostConnections[url.searchParams.get('source')])); return }
  if (path === '/host-ai') {
    try {
      const source = url.searchParams.get('source'), connection = hostConnections[source]
      const name = source === 'redis' ? 'redis_execute' : source === 'kafka' ? 'kafka_topics' : 'database_execute_sql'
      const verify = url.searchParams.get('verify') === '1'
      const args = { connectionId: connection.id, generation: connection.generation, ...(source === 'redis' ? { command: 'PING' } : source === 'kafka' ? {} : { sql: verify ? 'SELECT 1' : 'SELECT id FROM records', schema: 'app', purpose: verify ? 'verify' : 'result' }) }
      const result = await tools.get(name).execute(args, { agent: { session: { id: 'owner' } }, callId: 'browser-chain' })
      response.setHeader('Content-Type', 'application/json'); response.end(result)
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })) }
    return
  }

  try { response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html'); response.end(await readFile(resolve(directory, '.' + (path === '/' ? '/index.html' : path)))) }
  catch { response.writeHead(404); response.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const findings = [], errors = []
async function page(mode) { const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto('http://127.0.0.1:' + server.address().port + '/?mode=' + mode); await page.waitForFunction(() => window.probe); return page }
try {
  let current
  for (const source of ['mysql', 'oracle', 'redis', 'kafka']) {
    current = await page('chain-' + source)
    await current.waitForFunction(() => window.probe.document && window.probe.connection)
    const executed = await current.evaluate(source => fetch('/host-ai?source=' + source).then(response => response.json()), source)
    assert.ok(executed.executionId)
    await current.waitForFunction(() => !!window.probe.results.current)
    assert.equal(await current.evaluate(() => window.probe.results.current.identity.sourceId), source)
    await current.locator('.db-sql-result').waitFor()
    const expected = source === 'redis' ? 'OK' : source === 'kafka' ? 'demo' : '1'
    await current.locator('.db-sql-result').getByText(expected, { exact: true }).first().waitFor()
    const record = executions.get('owner', executed.executionId)
    assert.deepEqual(await current.evaluate(() => window.probe.results.current.identity), record.identity)
    assert.equal(await current.evaluate(() => window.probe.userEdits || 0), 0, 'remote CodeMirror synchronization must not become user edits')
    assert.equal(await current.evaluate(() => window.probe.document.confirmedController), 'ai')
    if (source === 'mysql' || source === 'oracle') {
      const before = await current.evaluate(() => window.probe.document.document)
      await current.evaluate(source => fetch('/host-ai?source=' + source + '&verify=1').then(response => response.json()), source)
      assert.deepEqual(await current.evaluate(() => window.probe.document.document), before, 'verification must not publish a document')
      assert.equal(await current.evaluate(() => window.probe.results.current.executionId), record.executionId)
    }
    await current.getByRole('button', { name: '收起结果' }).click()
    await current.evaluate(value => window.probe.results.accept(value), { identity: record.identity, executionId: record.executionId, result: await current.evaluate(() => window.probe.results.current.result) })
    await current.locator('.db-sql-result').waitFor({ state: 'hidden' })
    await current.locator('.cm-content').click()
    await current.keyboard.press('Control+End')
    await current.keyboard.insertText(' ')
    assert.equal(await current.evaluate(() => window.probe.userEdits), 1, 'real keyboard input must still take control')
    await current.evaluate(() => window.probe.document.flush())
    assert.equal(await current.evaluate(() => window.probe.results.stale), true)
    await current.evaluate(() => window.probe.document.returnToAi())
    assert.equal(await current.evaluate(() => window.probe.document.confirmedController), 'ai')
    await current.evaluate(source => fetch('/host-ai?source=' + source).then(response => response.json()), source)
    await current.waitForFunction(id => window.probe.results.current?.executionId !== id, executed.executionId)
    await current.locator('.db-sql-result').waitFor()
    findings.push({ id: source + '-registered-ai-host-worker-event-hook-renderer', status: 'PASS', executionId: executed.executionId })
    await current.close()
  }
  for (const source of ['hook', 'redis']) {
  current = await page(source); await current.waitForFunction(() => window.probe.document.text === 'TOPICS')
  await current.evaluate(() => window.probe.run())
  await current.waitForFunction(() => window.probe.results.current?.executionId === 'run')
  await current.evaluate(() => { window.probe.replaceServer({ ...window.probe.server(), text: 'GROUPS', revision: 2, controller: 'ai' }); return window.probe.document.load() })
  const staleReply = await current.evaluate(() => ({ text: window.probe.document.text, revision: window.probe.document.document.revision, replyText: window.probe.results.current?.identity.documentText, result: window.probe.results.current?.result }))
  assert.equal(staleReply.text, 'GROUPS'); assert.equal(staleReply.replyText, 'TOPICS'); assert.equal(staleReply.result.rows[0][0], 'old-result'); assert.equal(await current.evaluate(() => window.probe.results.stale), true)
  findings.push({ id: source + '-remote-document-preserves-readonly-result', status: 'PASS', observed: staleReply }); await current.close()

  }

  current = await page('grid-write')
  await current.evaluate(() => { window.probe.failQuery = true })
  await current.getByRole('button', { name: '运行', exact: true }).first().click()
  await current.getByRole('button', { name: '仅重试此条', exact: true }).waitFor()
  await current.evaluate(() => window.probe.setSchema('other')); await current.waitForFunction(() => window.probe.schema === 'other')
  await current.getByRole('button', { name: '仅重试此条', exact: true }).click()
  await current.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const retry = await current.evaluate(() => window.probe.calls)
  assert.deepEqual(retry.map(call => call.target), ['app'])
  findings.push({ id: 'retry-original-target-invalidated', status: 'PASS', observed: retry }); await current.close()

  current = await page('grid')
  await current.getByRole('button', { name: '运行', exact: true }).first().click(); await current.waitForFunction(() => window.probe.releaseQuery)
  await current.evaluate(() => window.probe.releaseQuery()); await current.getByText('old-app-result', { exact: true }).first().waitFor()
  await current.getByRole('button', { name: '开启维护', exact: true }).click()
  await current.locator('td[data-row="0"][data-col="1"]').dblclick(); await current.getByLabel('编辑 value', { exact: true }).fill('changed'); await current.getByLabel('编辑 value', { exact: true }).press('Enter')
  await current.evaluate(() => { window.probe.holdPreview = true })
  await current.getByRole('button', { name: '保存修改', exact: true }).click()
  await current.getByRole('button', { name: '确认', exact: true }).click()
  await current.waitForFunction(() => window.probe.releasePreview)
  await current.evaluate(() => window.probe.setSchema('other')); await current.waitForFunction(() => window.probe.schema === 'other')
  await current.evaluate(() => window.probe.releasePreview()); await current.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); assert.equal(await current.evaluate(() => window.probe.writeCalls || 0), 0)
  findings.push({ id: 'expired-preview-zero-dispatch', status: 'PASS', observed: await current.evaluate(() => ({ currentTarget: window.probe.schema, writes: window.probe.writeCalls })) }); await current.close()

  assert.deepEqual(errors, [])
  const report = { scope: 'registered tools, production Service/hooks/renderers and mounted SQL/Redis/Kafka CodeMirror editors; controlled Workers and delayed replies, no database', findings, pageErrors: errors }
  await writeFile(resolve(directory, 'browser-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); await service.dispose(); await executions.dispose(); hostStorage.cleanup() }

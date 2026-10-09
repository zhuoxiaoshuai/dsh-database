import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { Worker } from 'node:worker_threads'
import { ConnectionService } from '../src/host/connection-service.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { registerAiTools } from '../src/host/ai-tools.ts'

const root = resolve('artifacts/ui/sql-workspace')
await mkdir(root, { recursive: true })
const run = await mkdtemp(join(root, 'run-'))
// Render records produced by the actual tool/service lifecycle with a controlled Worker.
const catalogRecords = {}
for (const dialect of ['mysql', 'oracle']) {
  const directory = join(run, dialect + '-catalog')
  await mkdir(directory)
  const executions = new ExecutionStore(directory)
  const service = new ConnectionService(() => true, directory, undefined, undefined, executions, undefined,
    () => new Worker(new URL('../test/fixtures/sql-catalog-worker.mjs', import.meta.url), { workerData: { marker: join(directory, 'dispatch.jsonl') } }))
  try {
    const connection = await service.open('fixture', { name: dialect, dialect, host: 'db.test', port: 3306, database: 'app',
      oracleMode: 'service', username: 'reader', password: 'fixture', environment: 'sit' }, false)
    const tools = new Map()
    registerAiTools({ tools: { register: tool => tools.set(tool.name, tool) } }, service, executions, id => id === 'fixture')
    const result = JSON.parse(await tools.get('database_catalog').execute({ connectionId: connection.id, generation: connection.generation,
      kind: 'tables', schema: 'app' }, { agent: { session: { id: 'fixture' } }, callId: 'catalog-ui', rootCallId: 'catalog-ui-root' }))
    catalogRecords[dialect] = executions.get('fixture', result.executionId)
  } finally { await service.dispose(); await executions.dispose() }
}
await build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
  import React, { useRef, useState } from 'react'
  import { createRoot } from 'react-dom/client'
  import { StandardSourceMount } from './src/client/workspace-sources.tsx'
  import { clientModules } from './src/client/data-sources/registry.ts'
  import { SchemaCache } from './src/client/schema/schema-cache.ts'
  import { updateExecutionDocument, controlExecutionDocument } from './src/shared/execution-document.ts'
  import { validateBrowserFormat } from './src/host/sql-browser-request.ts'
  import './src/client/style.css'
  const sourceId = new URLSearchParams(location.search).get('source') || 'mysql'
  const catalogRecord = ${JSON.stringify(catalogRecords)}[sourceId]
  const history = [{ ...catalogRecord, connectionId: sourceId + '-fixture', generation: 'g1' }]
  const schema = sourceId === 'oracle' ? 'APP' : 'app'
  const result = { columns: ['id', 'value'], rows: [['1', 'fixture value']], truncated: false, elapsedMs: 1 }
  let canonicalDocument = { sourceId, text: 'SELECT 1', context: { schema }, controller: 'ai', revision: 1 }
  const queryProjection = () => ({ sql: canonicalDocument.text, schema: canonicalDocument.context.schema, controller: canonicalDocument.controller, revision: canonicalDocument.revision })
  let items = [{ id: 'template-a', title: '经验 A', summary: 'SQL 经验', tags: [], dialect: sourceId, version: 1, originalSql: 'SELECT 10' }, { id: 'template-b', title: '经验 B', summary: '', tags: [], dialect: sourceId, version: 1, originalSql: 'SELECT 20' }]
  let waiters = 0, maxWaiters = 0, documentCalls = 0
  const calls = [], patches = [], publications = [], formats = []
  let reads = 0
  const bridge = {
    mode: 'host', tables: () => [],
    catalog: async (_connection, request) => request.kind === 'schemas' ? { items: [{ name: schema }, { name: 'OTHER' }] }
      : request.kind === 'tables' ? { items: [{ name: 'demo', kind: 'TABLE' }, { name: 'demo_view', kind: 'VIEW' }] }
      : { items: [], kind: 'TABLE', columns: [{ name: 'id', type: 'INT', primaryKey: true }, { name: 'value', type: 'VARCHAR' }], indexes: [] },
    browse: async () => result,
    execute: async (_connection, sql, signal) => {
      calls.push(sql)
      if (window.deferQuery) { window.deferQuery = false; return new Promise((resolve, reject) => { window.pendingQuery = { resolve, reject } }) }
      const statements = sql.split(';').map(text => text.trim()).filter(Boolean)
      const batch = [], steps = statements.map((sql, index) => ({ index, sql, status: 'not-run' }))
      for (const [index, sql] of statements.entries()) {
        if (sql.includes('FAIL') && !window.allowRetry) { steps[index].status = 'failed'; throw Object.assign(new Error('fixture failed statement'), { effect: 'none', phase: 'execute', batch, steps }) }
        steps[index].status = 'succeeded'; batch.push(result)
      }
      if (sql.includes('SLOW')) await new Promise((done, reject) => { const timer = setTimeout(done, 3000); signal?.addEventListener('abort', () => { clearTimeout(timer); window.stoppedQueries = (window.stoppedQueries || 0) + 1; reject(new Error('cancelled fixture')) }, { once: true }) })
      return { ...result, batch, steps }
    },
    executeManual: async (...args) => bridge.execute(...args),
    maintenance: async (_connection, request) => request.kind === 'enable' ? { enabled: request.enabled } : { canEnable: false, reason: 'fixture readonly result', columns: [], resultPrimaryKeys: [], identityColumns: [] },
    templates: async (action, body) => {
      if (action === 'template-search') return { items: items.filter(item => !body.query || item.title.includes(body.query)) }
      if (action === 'template-get') return items.find(item => item.id === body.id)
      if (action === 'template-preview') return { draft: { features: { parseOk: true } }, similar: [{ id: 'template-a', title: '经验 A', version: 1, score: .6, reasons: ['fixture similarity'] }] }
      if (action === 'template-publish') { publications.push(body); const item = { id: body.targetId || 'saved-template', title: body.title, summary: body.summary, tags: body.tags, dialect: sourceId, version: (body.expectedVersion || 0) + 1, originalSql: body.sql }; items = [...items.filter(old => old.id !== item.id), item]; return item }
      if (action === 'template-archive') { items = items.filter(item => item.id !== body.id); return { ok: true } }
      throw new Error('unexpected template action ' + action)
    },
    executions: async (action, body, signal) => {
      if (action.startsWith('execution-document-')) ++documentCalls
      if (action === 'execution-wait') {
        ++waiters; maxWaiters = Math.max(maxWaiters, waiters)
        await new Promise(done => { let finished = false; const finish = () => { if (finished) return; finished = true; --waiters; clearTimeout(timer); signal?.removeEventListener('abort', finish); done() }; const timer = setTimeout(finish, 200); signal?.addEventListener('abort', finish, { once: true }); if (signal?.aborted) finish() })
        return { revision: 1, items: history, events: [], storage: window.storageState }
      }
      if (action === 'execution-get') return history.find(item => item.executionId === body.executionId)
      if (action.startsWith('shared-query-')) throw new Error('client used legacy document adapter')
      if (action === 'execution-persistence-retry') { window.storageRetryCount = (window.storageRetryCount || 0) + 1; if (window.storageRetryFailure) { window.storageRetryFailure = false; throw new Error('fixture persist failed') }; window.storageState = { executionHistory: { degraded: false, retrying: false }, workspace: { degraded: false } }; return { saved: true } }
      if (action === 'execution-document-get') { ++reads; const snapshot = canonicalDocument; if (window.deferGet) { window.deferGet = false; await new Promise(resolve => { window.pendingGet = resolve }) }; return { document: snapshot } }
      if (action === 'execution-latest') return {}
      if (action === 'execution-document-update') {
        if (body.source === 'format') {
          formats.push(body)
          if (window.rejectFormat) { window.rejectFormat = false; throw new Error('fixture format rejected') }
          if (window.conflictFormat) { window.conflictFormat = false; canonicalDocument = { ...canonicalDocument, revision: canonicalDocument.revision + 1 } }
          validateBrowserFormat(queryProjection(), { sql: body.text, schema: body.context.schema }, sourceId, body.revision)
        } else if (window.deferSave) { window.deferSave = false; await new Promise((resolve, reject) => { (window.pendingSaves ||= []).push({ resolve, reject }) }) }
        canonicalDocument = updateExecutionDocument(canonicalDocument, body.text, body.source === 'format' ? 'system' : 'user', body.revision, body.context)
        const snapshot = canonicalDocument
        if (body.source === 'format' && window.deferFormat) { window.deferFormat = false; await new Promise(resolve => { window.pendingFormat = resolve }) }
        return { document: snapshot }
      }
      if (action === 'execution-document-control') { if (window.missingControlReceipt) { window.missingControlReceipt = false; return {} }; if (body.revision !== canonicalDocument.revision) throw new Error('fixture stale revision'); canonicalDocument = controlExecutionDocument(canonicalDocument, body.controller); const snapshot = canonicalDocument; if (window.deferControl) { window.deferControl = false; await new Promise(resolve => { window.pendingControl = resolve }) }; return { document: snapshot } }
      if (action === 'execution-document-run') { const identity = { conversationId: 'fixture', sourceId, context: { ...canonicalDocument.context }, connectionId: window.fixture.inspect().connectionId, generation: window.fixture.inspect().generation, schema: canonicalDocument.context.schema, queryRevision: canonicalDocument.revision, documentText: canonicalDocument.text, executedSql: body.text || canonicalDocument.text, initiator: 'user' }; if (window.failAiRun) { window.failAiRun = false; throw Object.assign(new Error('fixture partial commit'), { ...identity, identity, executionId: 'partial-execution', executionStatus: 'unknown', steps: [{ index: 0, sql: 'INSERT one', status: 'succeeded', affectedRows: 1 }, { index: 1, sql: 'INSERT two', status: 'unknown' }, { index: 2, sql: 'INSERT three', status: 'not-run' }], batch: [{ ...result, affectedRows: 1 }] }) }; calls.push(body.text || canonicalDocument.text); if (window.deferAiRun) { window.deferAiRun = false; await new Promise(resolve => { window.pendingAiRun = resolve }) }; return { ...identity, identity, result: window.lateAiResult || result, executionId: 'fixture-execution', status: 'succeeded' } }
      return { items: [] }
    },
  }
  const cache = new SchemaCache(bridge.catalog, { prewarmTableLimit: 0 })
  let remount
  function Fixture() {
    const [epoch, setEpoch] = useState(0)
    const [connection, setConnection] = useState({ id: sourceId + '-fixture', generation: 'g1', name: sourceId, dialect: sourceId, environment: 'sit', database: schema, live: true, health: 'ready', workbench: { schema, queryTabs: [{ id: 'sql:restored', name: '原查询', sql: 'SELECT 1' }], activeTabId: 'sql:restored' } })
    const pendingRef = useRef(), actionsRef = useRef()
    const originalConnection = useRef()
    remount = () => setEpoch(value => value + 1)
    const context = { conversationId: 'fixture', host: bridge, connection, connections: [connection], cache, pendingRef, actionsRef, refreshToken: 0, catalogRoot: '', onPick() {}, onSchema() {}, onTreeBusy() {}, onTreeFocus() {}, onWorkbench(id, patch) { patches.push(patch); if (originalConnection.current?.id === id) originalConnection.current = { ...originalConnection.current, workbench: { ...originalConnection.current.workbench, ...patch } }; setConnection(previous => previous.id === id ? { ...previous, workbench: { ...previous.workbench, ...patch } } : previous) } }
    const module = clientModules.get(sourceId)
    window.fixture = { addHistory: (id, text, target, status = 'succeeded') => history.push({ ...catalogRecord, executionId: id, title: id, operation: 'workbench_shared_query', type: 'write', connectionId: sourceId + '-fixture', generation: 'g1', schema: target, executedSql: text, status, events: [] }), calls, patches, publications, formats, remount: () => remount(), openObject: () => actionsRef.current.openObject(schema, 'demo', 'table'), inspect: () => ({ maxWaiters, documentCalls, sharedQuery: queryProjection(), reads, connectionId: connection.id, generation: connection.generation }), reconnect: () => setConnection(previous => ({ ...previous, generation: 'g2' })), switchConnection: () => { originalConnection.current = connection; setConnection(previous => ({ ...previous, id: sourceId + '-second', workbench: { schema, queryTabs: [{ id: 'sql:restored', name: '原查询', sql: 'SELECT 1' }], activeTabId: 'sql:restored' } })) }, restoreConnection: () => setConnection(originalConnection.current) }
    return <div className="db-workbench"><StandardSourceMount key={epoch} module={module} context={context} /></div>
  }
  createRoot(document.getElementById('app')).render(<Fixture />)
` }, bundle: true, format: 'esm', outdir: run, entryNames: 'fixture' })
await writeFile(join(run, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>html,body,#app,.db-workbench{height:100%;margin:0}</style><div id="app"></div><script type="module" src="/fixture.js"></script>')
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://fixture').pathname
  const file = path === '/fixture.js' ? 'fixture.js' : path === '/fixture.css' ? 'fixture.css' : 'index.html'
  response.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html')
  response.end(await readFile(join(run, file)))
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const errors = [], checks = []
try {
  for (const source of ['mysql', 'oracle']) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/?source=${source}`)
      await page.getByRole('tab', { name: '原查询', exact: true }).waitFor()
      const editor = () => page.locator('.db-tab-body:not([hidden]) .cm-content').first()
      const fillEditor = async text => { await editor().click(); await page.keyboard.press('Control+A'); await page.keyboard.insertText(text) }
      const checkStructureClose = async () => {
        const body = page.locator('.db-tab-body:not([hidden])')
        const picker = body.getByLabel('选择表结构', { exact: true })
        await picker.click()
        await page.getByRole('listbox').getByRole('button', { name: 'demo', exact: true }).click()
        await body.getByRole('button', { name: '关闭表结构', exact: true }).click()
        assert.equal(await body.locator('.db-structure-pane').count(), 0)
        assert.equal(await picker.inputValue(), 'demo', 'closing preserves the selected table')
        await picker.click()
        await page.getByRole('listbox').getByRole('button', { name: 'demo', exact: true }).click()
        await page.setViewportSize({ width: 420, height: 800 })
        const bounds = await editor().boundingBox()
        assert.ok(bounds && bounds.width > 20 && bounds.x >= 0 && bounds.x + bounds.width <= 421, 'editor remains usable with structure on a narrow screen')
        await body.getByRole('button', { name: '关闭表结构', exact: true }).click()
        await page.setViewportSize({ width: 1200, height: 800 })
      }
      await checkStructureClose()
      await fillEditor('SELECT 100')
      await page.getByLabel('新建查询', { exact: true }).click()
      await fillEditor('SELECT 1; SELECT FAIL; SELECT 3;')
      await page.locator('.db-tab-body:not([hidden])').getByRole('button', { name: '运行', exact: true }).first().click()
      await page.getByRole('button', { name: '仅重试此条', exact: true }).waitFor()
      const preview = page.locator('.db-tab-body:not([hidden]) .db-sql-step-preview').first()
      await preview.getByText('fixture value', { exact: true }).waitFor()
      assert.ok((await preview.boundingBox()).height >= 120, 'each committed receipt has a visible bounded preview')
      assert.equal((await page.evaluate(() => window.fixture.calls)).length, 1)
      await page.evaluate(() => { window.allowRetry = true })
      await page.getByRole('button', { name: '仅重试此条', exact: true }).click()
      await page.waitForFunction(() => window.fixture.calls.length === 2)
      await page.evaluate(() => { window.allowRetry = false })
      await page.locator('.db-tab-body:not([hidden])').getByRole('button', { name: '运行', exact: true }).first().click()
      await page.getByRole('button', { name: '从此条继续', exact: true }).waitFor()
      await page.evaluate(() => { window.allowRetry = true })
      await page.getByRole('button', { name: '从此条继续', exact: true }).click()
      await page.waitForFunction(() => window.fixture.calls.length === 4)
      const newQuery = await page.getByRole('tab', { name: /^SQL-/ }).innerText()
      await page.locator('.db-query-tab').filter({ has: page.getByRole('tab', { name: newQuery, exact: true }) }).getByLabel('关闭页签', { exact: true }).click()
      await page.getByLabel('新建查询', { exact: true }).click()
      await page.getByRole('tab', { name: newQuery, exact: true }).waitFor()
      assert.equal(await editor().innerText(), 'SELECT 1; SELECT FAIL; SELECT 3;')
      await page.getByRole('tab', { name: '原查询', exact: true }).click()
      assert.equal(await editor().innerText(), 'SELECT 100')
      await fillEditor('SELECT 100 /* SLOW */')
      await page.locator('.db-tab-body:not([hidden])').getByRole('button', { name: '运行', exact: true }).first().click()
      await page.waitForFunction(() => window.fixture.calls.includes('SELECT 100 /* SLOW */'))
      await page.locator('.db-tab-body:not([hidden])').getByRole('button', { name: '停止', exact: true }).first().click()
      await page.waitForFunction(() => window.stoppedQueries === 1)
      await page.waitForFunction(() => !document.querySelector('.db-tab-body:not([hidden]) button.db-primary')?.disabled)
      assert.equal(await editor().innerText(), 'SELECT 100 /* SLOW */')
      await fillEditor('SELECT 100')
      await page.evaluate(() => window.fixture.openObject())
      await page.getByRole('tab', { name: /app\.demo/i }).waitFor()
      await page.evaluate(() => window.fixture.openObject())
      assert.equal(await page.getByRole('tab', { name: /app\.demo/i }).count(), 1)
      await page.getByRole('button', { name: 'AI Query', exact: true }).click()
      // Catalog records were already excluded from the visible AI query history.
      // Feeding a real catalog record must not introduce a new history item or editor result.
      await page.waitForFunction(() => window.fixture.inspect().reads > 0)
      await checkStructureClose()
      assert.equal(await page.locator('.db-ai-item-main').filter({ hasText: '查找 app 中的表' }).count(), 0)
      const formatButton = () => page.locator('.db-tab-body:not([hidden])').getByRole('button', { name: '格式化', exact: true }).first()
      const saveText = async text => {
        await fillEditor(text)
        await page.waitForFunction(text => window.fixture.inspect().sharedQuery.sql === text, text)
      }
      const runCount = await page.evaluate(() => window.fixture.calls.length)
      // History is a new edit on the same queue; the last selection survives a failed older save.
      await page.evaluate(() => { window.fixture.addHistory('history-A', 'SELECT 301', 'HISTORY'); window.fixture.addHistory('history-B', 'SELECT 302', undefined); window.fixture.addHistory('history-unknown', 'INSERT INTO demo VALUES (1)', 'HISTORY', 'unknown'); window.deferSave = true })
      await fillEditor('SELECT 300')
      await page.waitForFunction(() => window.pendingSaves?.length === 1)
      for (const title of ['history-A', 'history-B']) {
        await page.locator('.db-ai-item-main').filter({ hasText: title }).click()
        await page.getByRole('button', { name: '写入', exact: true }).click()
      }
      assert.equal(await editor().innerText(), 'SELECT 302')
      await page.evaluate(() => window.pendingSaves.shift().reject(new Error('history save failed')))
      await page.getByRole('button', { name: '重试保存', exact: true }).click()
      await page.waitForFunction(() => window.fixture.inspect().sharedQuery.sql === 'SELECT 302')
      assert.equal((await page.evaluate(() => window.fixture.inspect())).sharedQuery.schema, 'HISTORY', 'missing history target keeps the document target')
      await page.locator('.db-ai-item-main').filter({ hasText: 'history-unknown' }).click()
      assert.equal(await page.getByRole('button', { name: '写入', exact: true }).isDisabled(), true)
      await page.evaluate(() => window.fixture.reconnect())
      await page.waitForFunction(() => window.fixture.inspect().generation === 'g2')
      assert.equal(await page.getByRole('button', { name: '打开原目标核验', exact: true }).isDisabled(), true)
      await page.getByRole('checkbox', { name: /原代次已失效/ }).check()
      await page.getByRole('button', { name: '打开原目标核验', exact: true }).click()
      assert.equal((await editor().innerText()).trim(), '')
      assert.equal(await page.evaluate(() => window.fixture.calls.length), runCount, 'verification navigation never executes original SQL')
      await page.getByRole('button', { name: 'AI Query', exact: true }).click()
      await page.getByRole('button', { name: '关闭详情', exact: true }).click()
      await page.evaluate(() => { window.storageState = { executionHistory: { degraded: true, retrying: false }, workspace: { degraded: true } } })
      await page.getByRole('button', { name: '重试历史保存', exact: true }).click()
      await page.getByText('执行历史已可靠落盘。', { exact: true }).waitFor()
      assert.equal(await page.evaluate(() => window.storageRetryCount), 1)
      await page.evaluate(() => { window.storageState = { executionHistory: { degraded: true, retrying: true }, workspace: { degraded: false } }; window.storageRetryFailure = true })
      await page.getByRole('button', { name: '重试历史保存', exact: true }).click()
      await page.getByText('fixture persist failed', { exact: true }).waitFor()
      await page.evaluate(() => { window.storageState = { executionHistory: { degraded: false, retrying: false }, workspace: { degraded: false } } })
      await page.getByText('执行历史已可靠落盘。', { exact: true }).waitFor()
      assert.equal(await page.getByText('fixture persist failed', { exact: true }).count(), 0)
      assert.equal(await page.evaluate(() => window.fixture.calls.length), runCount)
      await saveText('SELECT 303')
      await page.evaluate(() => { window.failAiRun = true })
      await page.locator('.db-tab-body:not([hidden])').getByRole('button', { name: '运行', exact: true }).first().click()
      await page.getByText('fixture partial commit', { exact: false }).first().waitFor()
      await page.locator('.db-tab-body:not([hidden])').getByRole('tab', { name: '结果', exact: true }).click()
      assert.equal(await page.locator('.db-ai-collab .db-sql-step-item.is-ok').count(), 1)
      assert.equal(await page.locator('.db-ai-collab .db-sql-step-item.is-unknown').count(), 1)
      assert.equal(await page.locator('.db-ai-collab .db-sql-step-item.is-skipped').count(), 1)
      // Formatting waits for actual pending writes and uses the authoritative Host revision.
      await page.evaluate(() => { window.deferSave = true })
      await fillEditor('select 210 from records')
      await page.waitForFunction(() => window.pendingSaves?.length === 1)
      let beforeFormats = await page.evaluate(() => window.fixture.formats.length)
      await formatButton().click()
      await formatButton().click()
      assert.equal(await page.evaluate(() => window.fixture.formats.length), beforeFormats)
      await page.evaluate(() => window.pendingSaves.shift().resolve())
      await page.waitForFunction(n => window.fixture.formats.length === n + 1, beforeFormats)
      await page.waitForFunction(() => window.fixture.inspect().sharedQuery.sql.includes(String.fromCharCode(10)) && document.querySelector('.db-tab-body:not([hidden]) .cm-content')?.textContent.includes('from'))
      assert.equal((await page.evaluate(() => window.fixture.inspect())).sharedQuery.controller, 'user')
      await page.evaluate(() => { window.missingControlReceipt = true })
      await page.getByRole('button', { name: '归还 AI', exact: true }).click()
      await page.getByText('控制回执缺失或不一致，请刷新后重试。', { exact: true }).waitFor()
      assert.equal((await page.evaluate(() => window.fixture.inspect())).sharedQuery.controller, 'user')
      await page.getByRole('button', { name: '归还 AI', exact: true }).click()
      await page.waitForFunction(() => window.fixture.inspect().sharedQuery.controller === 'ai')
      assert.equal(await page.getByText('控制回执缺失或不一致，请刷新后重试。', { exact: true }).count(), 0)
      beforeFormats = await page.evaluate(() => window.fixture.formats.length)
      await formatButton().click()
      await page.waitForFunction(n => window.fixture.formats.length === n + 1, beforeFormats)
      assert.equal((await page.evaluate(() => window.fixture.inspect())).sharedQuery.controller, 'ai')
      // A delayed format receipt cannot replace newer input; the next save waits for it.
      await saveText('select 211 from records')
      await page.evaluate(() => { window.deferFormat = true })
      await formatButton().click()
      await page.waitForFunction(() => !!window.pendingFormat)
      await fillEditor('SELECT 212')
      await page.evaluate(() => { window.pendingFormat(); window.pendingFormat = null })
      await page.waitForFunction(() => window.fixture.inspect().sharedQuery.sql === 'SELECT 212')
      assert.equal(await editor().innerText(), 'SELECT 212')
      // Failed saves retain the final draft and block execution/format until explicit retry.
      await page.evaluate(() => { window.deferSave = true })
      await fillEditor('select 215 from records')
      await page.waitForFunction(() => window.pendingSaves?.length === 1)
      beforeFormats = await page.evaluate(() => window.fixture.formats.length)
      await formatButton().click()
      await page.evaluate(() => window.pendingSaves.shift().reject(new Error('fixture save failure')))
      await page.getByRole('button', { name: '重试保存', exact: true }).click()
      await page.waitForFunction(() => window.fixture.inspect().sharedQuery.sql === 'select 215 from records')
      assert.equal(await editor().innerText(), 'select 215 from records')
      assert.equal(await page.evaluate(() => window.fixture.formats.length), beforeFormats)
      // Text and target use the same revision and canonical document.
      await page.locator('.db-tab-body:not([hidden])').getByLabel('切换数据库', { exact: true }).click()
      await page.getByRole('listbox').getByRole('button', { name: 'OTHER', exact: true }).click()
      await page.waitForFunction(() => window.fixture.inspect().sharedQuery.schema === 'OTHER')
      await saveText('SELECT 218')
      assert.equal((await page.evaluate(() => window.fixture.inspect())).sharedQuery.schema, 'OTHER')
      assert.equal(await page.evaluate(() => window.fixture.calls.length), runCount, 'formatting never executes SQL')
      await page.getByRole('button', { name: 'AI Query', exact: true }).click()
      await fillEditor('SELECT 200')
      await page.waitForFunction(() => window.fixture.inspect().sharedQuery.controller === 'user')
      await page.getByRole('button', { name: '归还 AI', exact: true }).click()
      await page.waitForFunction(() => window.fixture.inspect().sharedQuery.controller === 'ai')
      const beforeAi = await page.evaluate(() => window.fixture.calls.length)
      await page.evaluate(() => { window.deferControl = true })
      await page.locator('.db-tab-body:not([hidden])').getByRole('button', { name: '运行', exact: true }).first().click()
      await page.waitForFunction(() => !!window.pendingControl)
      await fillEditor('SELECT 201')
      await page.evaluate(() => { window.pendingControl(); window.pendingControl = null })
      await page.waitForFunction(() => !document.querySelector('.db-tab-body:not([hidden]) button.db-primary')?.disabled)
      assert.equal(await page.evaluate(() => window.fixture.calls.length), beforeAi, 'editing during control acquisition must not dispatch old SQL')
      await page.waitForFunction(() => window.fixture.inspect().sharedQuery.sql === 'SELECT 201')
      await page.evaluate(() => { window.deferAiRun = true; window.lateAiResult = { columns: ['value'], rows: [['late AI value']], elapsedMs: 1, truncated: false } })
      await page.locator('.db-tab-body:not([hidden])').getByRole('button', { name: '运行', exact: true }).first().click()
      await page.waitForFunction(() => !!window.pendingAiRun)
      await fillEditor('SELECT 202')
      await page.evaluate(() => { window.pendingAiRun(); window.pendingAiRun = null })
      await page.waitForFunction(() => !document.querySelector('.db-tab-body:not([hidden]) button.db-primary')?.disabled)
      assert.equal(await page.getByText('late AI value', { exact: true }).count(), 0)
      await page.getByRole('button', { name: '经验库', exact: true }).click()
      await page.locator('.db-tab-body:not([hidden]) .db-template-list-main').filter({ hasText: '经验 A' }).click()
      await checkStructureClose()
      await fillEditor('SELECT 11')
      await page.locator('.db-tab-body:not([hidden]) .db-template-list-main').filter({ hasText: '经验 B' }).click()
      await page.waitForFunction(() => document.querySelector('.db-tab-body:not([hidden]) .cm-content')?.textContent === 'SELECT 20')
      await page.locator('.db-tab-body:not([hidden]) .db-template-list-main').filter({ hasText: '经验 A' }).click()
      await page.waitForFunction(() => document.querySelector('.db-tab-body:not([hidden]) .cm-content')?.textContent === 'SELECT 11')
      assert.equal(await editor().innerText(), 'SELECT 11')
      await page.getByRole('button', { name: '变体', exact: true }).click()
      await page.waitForFunction(() => window.fixture.publications.length === 1)
      assert.equal((await page.evaluate(() => window.fixture.publications))[0].publishAction, 'variant')
      await page.evaluate(() => { window.deferQuery = true })
      await page.locator('.db-tab-body:not([hidden])').getByRole('button', { name: '运行', exact: true }).first().click()
      await page.waitForFunction(() => !!window.pendingQuery)
      await page.locator('.db-tab-body:not([hidden]) .db-template-list-main').filter({ hasText: '经验 B' }).click()
      await page.waitForFunction(() => document.querySelector('.db-tab-body:not([hidden]) .cm-content')?.textContent === 'SELECT 20')
      await page.evaluate(() => { window.pendingQuery.reject(new Error('late fixture failure')); window.pendingQuery = null })
      await page.waitForFunction(() => !document.querySelector('.db-tab-body:not([hidden]) button.db-primary')?.disabled)
      assert.equal(await editor().innerText(), 'SELECT 20')
      assert.equal(await page.getByText('late fixture failure', { exact: true }).count(), 0)
      assert.equal((await page.evaluate(() => window.fixture.inspect())).documentCalls > 0, true)
      assert.equal((await page.evaluate(() => window.fixture.inspect())).maxWaiters, 1)
      for (const dark of [false, true]) for (const width of [420, 768, 1200]) {
        await page.setViewportSize({ width, height: 800 })
        await page.evaluate(dark => document.querySelector('.db-workbench').classList.toggle('db-dark', dark), dark)
        await page.getByRole('tab', { name: '原查询', exact: true }).click()
        await editor().click()
        const bounds = await editor().boundingBox()
        assert.ok(bounds && bounds.width > 20 && bounds.x >= 0 && bounds.x + bounds.width <= width + 1)
        await page.screenshot({ path: join(run, `${source}-${width}-${dark ? 'dark' : 'light'}.png`) })
      }
      await page.waitForFunction(() => window.fixture.patches.some(patch => patch.queryTabs?.some(tab => tab.sql === 'SELECT 100')))
      await page.evaluate(() => window.fixture.remount())
      await page.getByRole('tab', { name: '原查询', exact: true }).click()
      assert.equal(await editor().innerText(), 'SELECT 100')
      checks.push(`${source}: production standard mount, restored/dynamic tabs, close/reopen draft, batch failure/retry/continue, stop, object identity, AI control and late replies; verified history apply while pending/failing save, missing target fallback, unknown navigation/no replay, partial receipts and storage retry without execution; canonical document protocol, format preserving control, pending/failed saves, explicit retry, late format reply and atomic schema/text; SQL knowledge sessions/variant and late failure, single active subscription, widths/themes`)
    } catch (error) {
      await page.screenshot({ path: join(run, `${source}-failed.png`) })
      await writeFile(join(run, 'failure.json'), JSON.stringify({ status: 'FAIL', source, message: error.message, pageErrors: errors, visible: await page.locator('body').innerText() }, null, 2))
      throw error
    } finally { await page.close() }
  }
  assert.deepEqual(errors, [])
  const report = { status: 'PASS', evidence: 'actual client modules and public mount; controlled bridge, not real database', checks, pageErrors: errors }
  await writeFile(join(run, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally { await browser.close(); await new Promise(done => server.close(done)) }

import test from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConnectionService } from '../src/host/connection-service.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { registerAiTools } from '../src/host/ai-tools.ts'
import { workbenchEditorViews } from '../src/host/workbench-editors.ts'
import { publicConnection } from '../src/host/saved-connections.ts'
import { hashConversationId } from '../src/host/conversation-workbench-store.ts'
import { mergeSessionConnections } from '../src/client/schema/refresh.ts'
import { temporaryDirectory, connectionInput } from './helpers.mjs'

async function fixture(t) {
  const directory = temporaryDirectory(t, 'shared-query-doc-')
  const marker = join(directory, 'dispatch.jsonl')
  const executions = new ExecutionStore(directory)
  let worker
  const service = new ConnectionService(() => true, directory, undefined, undefined, executions, undefined,
    () => { worker = new Worker(new URL('./fixtures/sql-operation-worker.mjs', import.meta.url), { workerData: { marker } }); return worker })
  t.after(async () => { await service.dispose(); await executions.dispose() })
  const connection = await service.open('owner', connectionInput(), false)
  return { service, executions, directory, connection, worker: () => worker }
}

const toolExecution = owner => ({ callId: 'call-1', rootCallId: 'root-1', agent: { session: { id: owner } }, signal: new AbortController().signal })

test('刻画：getSharedQuery 的 lastRun 来自执行记录，迁移后的编辑器视图恒取不到 lastRun', async t => {
  const f = await fixture(t)
  f.service.updateSharedQuery('owner', f.connection.id, { sql: 'SELECT id FROM records', schema: 'app' }, 'system',
    f.service.getExecutionDocument('owner', f.connection.id).revision)
  await f.service.runSharedQuery('owner', { connectionId: f.connection.id, generation: f.connection.generation, schema: 'app',
    sql: 'SELECT id FROM records', revision: f.service.getSharedQuery('owner', f.connection.id).revision, initiator: 'ai', purpose: 'result' })
  const document = f.service.getExecutionDocument('owner', f.connection.id)
  assert.equal(document.text, 'SELECT id FROM records')
  const query = f.service.getSharedQuery('owner', f.connection.id)
  assert.equal(query.lastRun?.rowCount, 1, 'getSharedQuery 的 lastRun 由执行记录算出')
  const snapshot = f.service.snapshot('owner')
  const workbench = snapshot.connections.find(item => item.id === f.connection.id)?.workbench
  assert.equal(workbench?.aiDocument?.text, document.text, 'aiDocument 是权威文档')
  assert.equal(Object.hasOwn(workbench?.sharedQuery || {}, 'lastRun'), false, 'publicConnection 的公共投影不含 lastRun')
  const view = workbenchEditorViews(snapshot).find(item => item.connectionId === f.connection.id)
  assert.equal(view?.lastRun, undefined, '迁移后的文档，workbench-editors 读到的 lastRun 恒为 undefined')
  assert.equal(view?.aiQuery?.sql, document.text)
})

test('刻画：旧持久化 sharedQuery.lastRun 在迁移为 aiDocument 时丢弃，编辑器视图取不到', async t => {
  const f = await fixture(t)
  const id = f.connection.id
  const owner = 'legacy-owner'
  const path = join(f.directory, 'conversation-workbenches', `${hashConversationId(owner)}.json`)
  mkdirSync(join(f.directory, 'conversation-workbenches'), { recursive: true })
  writeFileSync(path, JSON.stringify({ version: 2, workbenches: { [id]: { sharedQuery: {
    sql: 'SELECT 1', schema: 'app', controller: 'ai', revision: 7,
    lastRun: { columns: ['id'], rowCount: 1, truncated: false, elapsedMs: 3, at: '2026-10-26' },
  } } } }))
  const snapshot = f.service.snapshot(owner)
  const workbench = snapshot.connections.find(item => item.id === id)?.workbench
  assert.equal(workbench?.aiDocument?.text, 'SELECT 1', '旧 SharedQuery 迁移为 aiDocument')
  assert.equal(workbench?.aiDocument?.revision, 7)
  assert.equal(Object.hasOwn(workbench?.sharedQuery || {}, 'lastRun'), false, '迁移后的公共投影不含 lastRun')
  const view = workbenchEditorViews(snapshot).find(item => item.connectionId === id)
  assert.equal(view?.lastRun, undefined, '迁移后的文档恒取不到 lastRun')
  assert.deepEqual(view?.aiQuery, { sql: 'SELECT 1', controller: 'ai', revision: 7 })
})

test('刻画：database_status 与编辑器视图的 controller/revision 与执行文档一致', async t => {
  const f = await fixture(t)
  f.service.updateSharedQuery('owner', f.connection.id, { sql: 'SELECT 2', schema: 'app' }, 'user',
    f.service.getExecutionDocument('owner', f.connection.id).revision)
  const document = f.service.getExecutionDocument('owner', f.connection.id)
  assert.equal(document.controller, 'user')
  const tools = new Map()
  registerAiTools({ tools: { register(tool) { tools.set(tool.name, tool) } } }, f.service, f.executions, () => true)
  const status = JSON.parse(await tools.get('database_status').execute({}, toolExecution('owner')))
  const summary = status.connections.find(item => item.connectionId === f.connection.id)
  assert.equal(summary.controller, document.controller)
  assert.equal(summary.sharedQueryRevision, document.revision)
  const view = workbenchEditorViews(f.service.snapshot('owner')).find(item => item.connectionId === f.connection.id)
  assert.deepEqual(view.aiQuery, { sql: document.text, controller: document.controller, revision: document.revision })
  assert.equal(view.schema, 'app')
})

test('刻画：非 SQL 文档不进入编辑器视图的 aiQuery', () => {
  const views = workbenchEditorViews({ connections: [{ id: 'r1', name: 'cache', dialect: 'redis', environment: 'sit', database: '0', version: '', live: true,
    workbench: { aiDocument: { sourceId: 'redis', text: 'GET k', context: { database: '0' }, revision: 2, controller: 'ai' } } }], passwordStorage: false })
  assert.deepEqual(views, [], 'redis 文档没有 aiQuery，也不进编辑器视图')
})

test('刻画：公共投影的 schema 与文档 context.schema 一致（含空串）', () => {
  const row = { id: 'c1', settings: connectionInput(), desiredState: 'offline' }
  for (const context of [{ schema: 'app' }, { schema: '' }, {}]) {
    const projected = publicConnection(row, undefined, { aiDocument: { sourceId: 'mysql', text: 'SELECT 1', context, revision: 1, controller: 'ai' } })
    assert.equal(projected.workbench?.sharedQuery?.schema, context.schema || '')
    assert.equal(projected.workbench?.sharedQuery?.schema || '', projected.workbench?.aiDocument?.context.schema || '')
  }
})

test('刻画：切对话时文档跟随目标会话的 aiDocument', () => {
  const base = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'app', version: '8', live: true }
  const previous = { ...base, workbench: { aiDocument: { sourceId: 'mysql', text: 'SELECT 1', context: { schema: 'app' }, revision: 1, controller: 'ai' } } }
  const next = { ...base, workbench: { aiDocument: { sourceId: 'mysql', text: 'SELECT 2', context: { schema: 'hr' }, revision: 3, controller: 'user' } } }
  const [merged] = mergeSessionConnections([previous], [next])
  assert.equal(merged.workbench?.aiDocument?.text, 'SELECT 2')
  assert.equal(merged.workbench?.aiDocument, next.workbench.aiDocument)
})

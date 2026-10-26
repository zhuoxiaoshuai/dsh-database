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

/** 直接种一条执行记录：只用来刻画 lastRun 的匹配/可见性规则，生产侧仍从执行记录现算。 */
function seedQueryRun(f, owner, document, patch = {}) {
  const record = f.executions.create({
    conversationId: owner,
    callId: 'seed-call-1',
    rootCallId: 'seed-root-1',
    connectionId: f.connection.id,
    generation: f.connection.generation,
    schema: document.context.schema || '',
    operation: 'database_execute_sql',
    sql: document.text,
    documentText: document.text,
    queryRevision: document.revision,
    type: 'query',
    ...patch,
  })
  f.executions.complete(record.executionId, 'succeeded', undefined, { columns: ['id'], rows: [['1']], truncated: false, elapsedMs: 3 })
  return f.executions.get(owner, record.executionId, true)
}

test('已修复：lastRun 现在来自执行记录，getSharedQuery、公共投影与编辑器视图完全同源', async t => {
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
  assert.deepEqual(workbench?.sharedQuery?.lastRun, query.lastRun, '已修复，lastRun 现在来自执行记录：公共投影的 lastRun 与 getSharedQuery 同源')
  const view = workbenchEditorViews(snapshot).find(item => item.connectionId === f.connection.id)
  assert.deepEqual(view?.lastRun, query.lastRun, '已修复，lastRun 现在来自执行记录：编辑器视图的 lastRun 与 getSharedQuery 完全一致')
  for (const field of ['columns', 'rowCount', 'elapsedMs', 'message', 'at']) {
    assert.deepEqual(view?.lastRun?.[field], query.lastRun?.[field], `已修复，lastRun 现在来自执行记录：lastRun.${field} 与 getSharedQuery 完全一致`)
  }
  assert.equal(view?.aiQuery?.sql, document.text)
  const tools = new Map()
  registerAiTools({ tools: { register(tool) { tools.set(tool.name, tool) } } }, f.service, f.executions, () => true)
  const collab = JSON.parse(await tools.get('database_read_collab').execute({}, toolExecution('owner')))
  // 工具输出是 JSON 文本，undefined 字段不出现；比较 JSON 规范化后的同源值。
  const json = value => JSON.parse(JSON.stringify(value))
  assert.deepEqual(json(collab.items.find(item => item.connectionId === f.connection.id)?.lastRun), json(query.lastRun),
    '已修复，lastRun 现在来自执行记录：database_read_collab 的编辑器视图同源')
})

test('已修复：无执行记录时 lastRun 仍为 undefined，不出现空对象', async t => {
  const f = await fixture(t)
  f.service.updateSharedQuery('owner', f.connection.id, { sql: 'SELECT id FROM records', schema: 'app' }, 'system',
    f.service.getExecutionDocument('owner', f.connection.id).revision)
  const query = f.service.getSharedQuery('owner', f.connection.id)
  assert.equal(query.lastRun, undefined, '没有执行记录时 getSharedQuery 没有 lastRun')
  assert.equal(query.lastExecutionId, undefined)
  const snapshot = f.service.snapshot('owner')
  const workbench = snapshot.connections.find(item => item.id === f.connection.id)?.workbench
  assert.equal(Object.hasOwn(workbench?.sharedQuery || {}, 'lastRun'), false, '无执行记录时公共投影不含 lastRun 字段（字段不存在，不是 undefined 值）')
  const view = workbenchEditorViews(snapshot).find(item => item.connectionId === f.connection.id)
  assert.deepEqual(view?.lastRun, undefined, '已修复，lastRun 现在来自执行记录：没有执行记录时编辑器视图的 lastRun 仍是 undefined，不许出现空对象')
  assert.deepEqual(view?.lastRun, query.lastRun, '已修复，lastRun 现在来自执行记录：与 getSharedQuery 一致')
})

test('已修复：lastRun 的用户可见性规则与 getSharedQuery 一致（用户接管后 AI 记录不算）', async t => {
  const f = await fixture(t)
  const id = f.connection.id
  const viewOf = () => workbenchEditorViews(f.service.snapshot('owner')).find(item => item.connectionId === id)
  f.service.updateSharedQuery('owner', id, { sql: 'SELECT id FROM records', schema: 'app' }, 'system',
    f.service.getExecutionDocument('owner', id).revision)
  await f.service.runSharedQuery('owner', { connectionId: id, generation: f.connection.generation, schema: 'app',
    sql: 'SELECT id FROM records', revision: f.service.getSharedQuery('owner', id).revision, initiator: 'ai', purpose: 'result' })
  const aiRun = f.service.getSharedQuery('owner', id)
  assert.equal(aiRun.lastRun?.rowCount, 1, 'AI 执行产生 lastRun')
  assert.deepEqual(viewOf()?.lastRun, aiRun.lastRun, '已修复，lastRun 现在来自执行记录：AI 执行后编辑器视图同源')
  f.service.takeSharedQuery('owner', id, 'user-takeover', aiRun.revision)
  const document = f.service.getExecutionDocument('owner', id)
  assert.equal(document.controller, 'user')
  // 一条 revision/text/schema 都匹配、只有 initiator=ai 的记录：用户接管后不得计入 lastRun。
  const hidden = seedQueryRun(f, 'owner', document, { initiator: 'ai' })
  const taken = f.service.getSharedQuery('owner', id)
  assert.equal(taken.lastRun, undefined, "initiator='ai' 且 controller='user' 的执行记录不算 lastRun")
  assert.deepEqual(viewOf()?.lastRun, taken.lastRun, '已修复，lastRun 现在来自执行记录：可见性规则与 getSharedQuery 一致')
  // 用户自己的执行仍计入，且结果摘要同源。
  const visible = seedQueryRun(f, 'owner', document, { initiator: 'user', callId: 'seed-user' })
  const userRun = f.service.getSharedQuery('owner', id)
  assert.equal(userRun.lastRun?.executionId, visible.executionId, "initiator='user' 的执行记录计入 lastRun")
  assert.equal(userRun.lastRun?.executionId !== hidden.executionId, true, '计入的是用户执行记录')
  assert.deepEqual(userRun.lastRun?.columns, ['id'])
  assert.equal(userRun.lastRun?.elapsedMs, 3)
  assert.deepEqual(viewOf()?.lastRun, userRun.lastRun, '已修复，lastRun 现在来自执行记录：编辑器视图与 getSharedQuery 完全一致')
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
  assert.equal(Object.hasOwn(workbench?.sharedQuery || {}, 'lastRun'), false, '迁移丢弃的旧 lastRun 不回流：无执行记录时公共投影不含 lastRun 字段')
  const view = workbenchEditorViews(snapshot).find(item => item.connectionId === id)
  assert.equal(view?.lastRun, undefined, '已修复，lastRun 现在来自执行记录：旧 lastRun 随迁移丢弃，没有执行记录时编辑器视图仍取不到')
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

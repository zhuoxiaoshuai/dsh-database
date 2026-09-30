import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerDatabase } from '../src/host/register.ts'
import { connectionInput, temporaryDirectory } from './helpers.mjs'

const workerUrl = pathToFileURL(join(process.cwd(), 'test/fixtures/database-worker.mjs'))
const input = connectionInput({ password: 'super-secret' })

function fixture(t) {
  const oldHome = process.env.DSH_HOME
  const directory = temporaryDirectory(t, 'database-ai-')
  process.env.DSH_HOME = directory
  const routes = new Map(), tools = new Map()
  const ctx = {
    sessions: { get: id => id === 'conversation-a' || id === 'conversation-b' ? { id } : undefined },
    connection: { requestRejection: () => undefined },
    webServer: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } },
    tools: { register: tool => tools.set(tool.name, tool) },
    on() { return () => {} },
  }
  const registration = registerDatabase(ctx, workerUrl)
  t.after(async () => {
    await registration.dispose()
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  })
  return { routes, tools }
}

function invoke(route, { method = 'GET', owner = 'conversation-a', body, signal } = {}) {
  const payload = body ? Buffer.from(JSON.stringify(body)) : undefined
  return new Promise((resolve, reject) => {
    if (signal?.aborted) reject(new Error('aborted'))
    const response = {
      status: 200, headers: {}, body: '', destroyed: false, writableEnded: false,
      writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers) },
      end(text = '') { this.body += String(text); this.writableEnded = true; resolve(this) },
      once(name, fn) { if (name === 'close' && signal) signal.addEventListener('abort', fn, { once: true }) },
      off() {},
    }
    const request = {
      method,
      url: `/plugins/database/connections?conversationId=${owner}`,
      headers: body ? { 'content-type': 'application/json' } : {},
      async *[Symbol.asyncIterator]() { if (payload) yield payload },
    }
    route.handler(request, response)
  })
}

const exec = (tool, args, extra = {}) => tool.execute(args, {
  callId: extra.callId || 'call-1',
  rootCallId: extra.rootCallId || 'root-1',
  agent: { session: { id: extra.owner || 'conversation-a' } },
  signal: extra.signal || new AbortController().signal,
})

test('the shared execution-document endpoint runs SQL after human takeover', async t => {
  const { routes } = fixture(t)
  const route = routes.get('/plugins/database/connections')
  const connected = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'connect', input } })).body)
  const updatedResponse = await invoke(route, { method: 'POST', body: {
    action: 'execution-document-update', id: connected.id, generation: connected.generation, text: 'SELECT id FROM records', revision: 1,
  } })
  assert.equal(updatedResponse.status, 200)
  const updated = JSON.parse(updatedResponse.body).document
  assert.equal(updated.sourceId, 'mysql')
  assert.equal(updated.controller, 'user')
  const runResponse = await invoke(route, { method: 'POST', body: {
    action: 'execution-document-run', id: connected.id, generation: connected.generation, revision: updated.revision,
  } })
  assert.equal(runResponse.status, 200)
  const result = JSON.parse(runResponse.body)
  assert.ok(result.result || result.rows || result.executionId)
  const staleResponse = await invoke(route, { method: 'POST', body: {
    action: 'execution-document-run', id: connected.id, generation: connected.generation, revision: updated.revision - 1,
  } })
  assert.notEqual(staleResponse.status, 200)
})

test('authenticated explorer requests use the connection source and reject an old generation', async t => {
  const { routes } = fixture(t)
  const route = routes.get('/plugins/database/connections')
  const connected = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'connect', input } })).body)
  const listed = await invoke(route, { method: 'POST', body: {
    action: 'explorer-list', id: connected.id, generation: connected.generation, input: {},
  } })
  assert.equal(listed.status, 200)
  const page = JSON.parse(listed.body)
  assert.equal(page.sourceId, 'mysql')
  assert.ok(Array.isArray(page.nodes))
  const stale = await invoke(route, { method: 'POST', body: {
    action: 'explorer-list', id: connected.id, generation: 'old-generation', input: {},
  } })
  assert.notEqual(stale.status, 200)
})

test('database tool schemas stay short and route once from status', t => {
  const { tools } = fixture(t)
  const databaseTools = [...tools.values()].filter(tool => tool.name.startsWith('database_'))
  assert.equal(databaseTools.length, 6)
  assert.deepEqual(databaseTools.map(tool => tool.name).sort(), [
    'database_catalog',
    'database_execute_sql',
    'database_import_connections',
    'database_read_collab',
    'database_status',
    'database_templates',
  ])
  assert.equal(tools.has('database_query_readonly'), false)
  assert.equal(tools.has('database_explain_plan'), false)
  assert.equal(tools.has('database_list_connections'), false)
  assert.equal(tools.has('database_dml_draft'), false)
  assert.equal(tools.has('database_ddl_draft'), false)
  assert.equal(tools.has('database_analyze_table_draft'), false)
  const status = tools.get('database_status')
  assert.match(status.description, /查库用 database_\*/)
  assert.match(tools.get('database_execute_sql').description, /action=read/)
  assert.doesNotMatch(status.description, /topic=all/)
  const resident = databaseTools.reduce((sum, tool) => sum + String(tool.description || '').length, 0)
  assert.ok(resident < 400, `resident descriptions are ${resident} chars`)
  for (const tool of databaseTools) {
    assert.ok(tool.description.length <= 90, `${tool.name} description is ${tool.description.length} chars`)
    if (tool.name !== 'database_status') {
      assert.doesNotMatch(tool.description, /Skill|Shell/)
    }
  }
})

test('database_status loads a call guide only when topic is set', async t => {
  const { tools } = fixture(t)
  const status = JSON.parse(await exec(tools.get('database_status'), {}))
  assert.equal(status.guide, undefined)
  assert.match(status.help, /工具名或 workflow/)
  assert.doesNotMatch(status.help, /topic=all/)
  const queryGuide = JSON.parse(await exec(tools.get('database_status'), { topic: 'database_execute_sql' }))
  assert.equal(queryGuide.topic, 'database_execute_sql')
  assert.match(queryGuide.args, /purpose/)
  assert.match(queryGuide.guide, /purpose=verify/)
  assert.match(queryGuide.guide, /EXPLAIN/)
  assert.ok(queryGuide.guide.length <= 500)
  assert.equal(queryGuide.connections, undefined)
  const aliased = JSON.parse(await exec(tools.get('database_status'), { topic: 'database_query_readonly' }))
  assert.equal(aliased.topic, 'database_execute_sql')
  assert.equal(aliased.alias, 'database_query_readonly')
  const dumped = JSON.parse(await exec(tools.get('database_status'), { topic: 'all' }))
  assert.equal(dumped.error, '未知 topic。')
  assert.ok(dumped.topics.includes('workflow'))
  assert.ok(dumped.topics.includes('database_catalog'))
  assert.equal(dumped.guides, undefined)
  const unknown = JSON.parse(await exec(tools.get('database_status'), { topic: 'bash' }))
  assert.equal(unknown.error, '未知 topic。')
  assert.ok(unknown.topics.includes('workflow'))
  assert.ok(unknown.topics.includes('database_execute_sql'))
  assert.equal(unknown.topics.includes('database_query_readonly'), false)
})

test('connection action dispatcher preserves unsupported-action responses', async t => {
  const { routes } = fixture(t)
  const route = routes.get('/plugins/database/connections')
  const unknown = await invoke(route, { method: 'POST', body: { action: 'future-action' } })
  assert.equal(unknown.status, 400)
  assert.deepEqual(JSON.parse(unknown.body), { error: '不支持此操作。' })
  const malformed = await invoke(route, { method: 'POST', body: { action: 'execution-get' } })
  assert.equal(malformed.status, 400)
  assert.deepEqual(JSON.parse(malformed.body), { error: '不支持此操作。' })
})

test('AI metadata and readonly query share execution ids and return cell values', async t => {
  const { routes, tools } = fixture(t)
  const route = routes.get('/plugins/database/connections')
  const connected = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'connect', input } })).body)
  const args = { connectionId: connected.id, generation: connected.generation, schema: 'app' }
  const status = JSON.parse(await exec(tools.get('database_status'), {}))
  assert.equal(status.connections[0].connectionId, connected.id)
  assert.ok(status.next.includes('database_catalog'))
  assert.ok(status.next.includes('database_execute_sql'))
  assert.equal(status.next.includes('database_search_tables'), false)
  assert.equal(JSON.stringify(status).includes('super-secret'), false)
  const schemas = JSON.parse(await exec(tools.get('database_catalog'), { ...args, kind: 'schemas' }))
  assert.ok(schemas.executionId)
  assert.match(schemas.sql, /SHOW DATABASES/)
  const tables = JSON.parse(await exec(tools.get('database_catalog'), { ...args, kind: 'tables', search: 'rec' }))
  assert.equal(tables.estimated, true)
  assert.match(tables.sql, /SHOW FULL TABLES/)
  const searchDetail = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'execution-get', executionId: tables.executionId } })).body)
  assert.equal(searchDetail.draft.kind, 'query')
  assert.match(searchDetail.sql, /SHOW FULL TABLES/)
  assert.match(searchDetail.draft.sql, /SELECT \*/)
  assert.match(searchDetail.title, /查找 app 中匹配“rec”的表/)
  assert.match(searchDetail.reason, /定位/)
  assert.match(searchDetail.conclusion, /查询成功|未找到/)
  assert.equal(searchDetail.operation, 'database_catalog')
  assert.equal(searchDetail.title.includes('database_search_tables'), false)
  const described = JSON.parse(await exec(tools.get('database_catalog'), { ...args, kind: 'table', table: 'records' }))
  assert.equal(described.indexes.status, 'unavailable')
  assert.match(described.indexes.reason, /无权/)
  const queried = JSON.parse(await exec(tools.get('database_execute_sql'), { ...args, sql: 'SELECT id, note FROM records', limit: 10 }))
  assert.equal(queried.ok, true)
  assert.equal(queried.rowCount, 1)
  assert.deepEqual(queried.rows[0], ['1', 'secret-value'])
  assert.ok(queried.rows.length <= 100)
  const detail = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'execution-get', executionId: queried.executionId } })).body)
  assert.equal(detail.callId, 'call-1')
  assert.deepEqual(detail.result.rows[0], ['1', 'secret-value'])
  const deleted = JSON.parse(await exec(tools.get('database_execute_sql'), { ...args, sql: 'DELETE FROM records' }))
  assert.equal(deleted.status, 'succeeded')
  assert.equal(deleted.sql.includes('DELETE'), true)
  const script = 'SELECT id FROM records; SELECT 2'
  const multi = JSON.parse(await exec(tools.get('database_execute_sql'), { ...args, sql: script }))
  assert.equal(multi.ok, true)
  assert.equal(multi.statements.length, 2)
  assert.equal(multi.message, '已执行 2 条')
  const multiDetail = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'execution-get', executionId: multi.executionId } })).body)
  assert.equal(multiDetail.operation, 'database_execute_sql')
  assert.equal(multiDetail.sql, script)
  assert.equal(multiDetail.result.batch.length, 2)
  await assert.rejects(exec(tools.get('database_execute_sql'), { ...args, sql: Array.from({ length: 9 }, (_, index) => `SELECT ${index + 1}`).join('; ') }), /最多执行 8 条/)
  await assert.rejects(exec(tools.get('database_execute_sql'), { ...args, sql: 'INSERT INTO records (id) VALUES (7); SELECT missing_column FROM records' }))
  const kept = JSON.parse(await exec(tools.get('database_execute_sql'), { ...args, sql: 'SELECT id FROM records WHERE id = 7' }))
  assert.equal(kept.rowCount, 1)
  await assert.rejects(exec(tools.get('database_execute_sql'), { ...args, sql: 'SELECT * FROM records FOR UPDATE' }), /锁定/)
  await assert.rejects(exec(tools.get('database_execute_sql'), { ...args, sql: 'SHOW INDEX FROM records' }), /暂不执行 SHOW/)
  const explained = JSON.parse(await exec(tools.get('database_execute_sql'), { ...args, sql: 'EXPLAIN SELECT id FROM records' }))
  assert.equal(explained.ok, true)
  assert.ok(explained.executionId)
})

test('database_execute_sql action=read reads the AI Query editor', async t => {
  const { routes, tools } = fixture(t)
  const route = routes.get('/plugins/database/connections')
  await assert.rejects(exec(tools.get('database_execute_sql'), {}), /action=read/)
  await assert.rejects(exec(tools.get('database_execute_sql'), { action: 'read' }), /请先连接/)
  const connected = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'connect', input } })).body)
  const args = { connectionId: connected.id, generation: connected.generation, schema: 'app' }
  const empty = JSON.parse(await exec(tools.get('database_execute_sql'), { action: 'read' }))
  assert.equal(empty.action, 'read')
  assert.equal(empty.sql, '')
  assert.equal(empty.connectionId, connected.id)
  assert.equal(empty.ok, undefined)
  const ran = JSON.parse(await exec(tools.get('database_execute_sql'), { ...args, sql: 'SELECT id FROM records' }))
  assert.equal(ran.ok, true)
  const seen = JSON.parse(await exec(tools.get('database_execute_sql'), { action: 'read' }))
  assert.equal(seen.action, 'read')
  assert.match(seen.sql, /SELECT id FROM records/)
  assert.equal(seen.ok, undefined)
  assert.equal(seen.rows, undefined)
})

test('AI cancel, conversation isolation, reconnect late results, and SIT writes', async t => {
  const { routes, tools } = fixture(t)
  const route = routes.get('/plugins/database/connections')
  const connected = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'connect', input } })).body)
  const args = { connectionId: connected.id, generation: connected.generation, schema: 'app' }
  const controller = new AbortController()
  const pending = exec(tools.get('database_execute_sql'), { ...args, sql: 'SELECT id FROM records WHERE note = \'SLEEP_TEST\'' }, { signal: controller.signal, callId: 'slow' })
  await new Promise(resolve => setTimeout(resolve, 30))
  const listed = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'execution-list' } })).body)
  const running = listed.items.find(item => item.callId === 'slow')
  assert.ok(running)
  const cancelled = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'execution-cancel', executionId: running.executionId } })).body)
  assert.ok(['cancelled', 'unknown'].includes(cancelled.status))
  await pending.catch(() => {})
  const other = JSON.parse((await invoke(route, { method: 'POST', owner: 'conversation-b', body: { action: 'execution-list' } })).body)
  assert.equal(other.items.length, 0)
  const reconnected = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'update', id: connected.id, input } })).body)
  assert.notEqual(reconnected.generation, connected.generation)
  const stale = listed.items[0]
  const after = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'execution-get', executionId: stale.executionId } })).body)
  assert.ok(['unknown', 'cancelled', 'succeeded', 'failed'].includes(after.status))
  const inserted = JSON.parse(await exec(tools.get('database_execute_sql'), {
    ...args, connectionId: reconnected.id, generation: reconnected.generation,
    sql: 'INSERT INTO records (id) VALUES (1)',
  }))
  assert.equal(inserted.status, 'succeeded')
  assert.ok(inserted.sql)
  const prod = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'connect', input: { ...input, name: 'prod', environment: 'prod' } } })).body)
  await assert.rejects(exec(tools.get('database_execute_sql'), {
    connectionId: prod.id, generation: prod.generation, schema: 'app', sql: 'INSERT INTO records (id) VALUES (9)',
  }), /只读/)
})

test('shared AI query CAS, busy, controlLost, and isolated workbenches', async t => {
  const { routes, tools } = fixture(t)
  const route = routes.get('/plugins/database/connections')
  const connected = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'connect', input } })).body)
  const other = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'connect', input: { ...input, name: 'other' } } })).body)
  const args = { connectionId: connected.id, generation: connected.generation, schema: 'app' }
  await invoke(route, { method: 'POST', body: { action: 'shared-query-control', id: connected.id, controller: 'ai' } })
  const first = JSON.parse(await exec(tools.get('database_execute_sql'), { ...args, sql: 'SELECT id, note FROM records', limit: 10 }))
  assert.deepEqual(first.rows[0], ['1', 'secret-value'])
  const collab = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'shared-query-get', id: connected.id } })).body)
  assert.equal(collab.sharedQuery.sql.includes('SELECT id, note FROM records'), true)
  assert.equal(collab.sharedQuery.controller, 'ai')
  const otherQuery = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'shared-query-get', id: other.id } })).body)
  assert.equal(otherQuery.sharedQuery.sql || '', '')
  const userRun = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'shared-query-run', id: connected.id, generation: connected.generation, schema: 'app', sql: 'SELECT id FROM records', initiator: 'user' } })).body)
  assert.equal(userRun.status, 'succeeded')
  assert.ok(userRun.result.rows)
  assert.equal(userRun.result.trustedAuthorization, true)
  const listed = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'execution-list' } })).body)
  assert.ok(listed.items.some(item => item.initiator === 'user'))
  const systemWrite = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'shared-query-update', id: connected.id, source: 'system', patch: { sql: 'SELECT id FROM records' }, revision: collab.sharedQuery.revision } })).body)
  assert.equal(systemWrite.sharedQuery.controller, 'ai')
  await invoke(route, { method: 'POST', body: { action: 'shared-query-update', id: connected.id, source: 'user', patch: { sql: 'SELECT 1' } } })
  await assert.rejects(exec(tools.get('database_execute_sql'), { ...args, sql: 'SELECT id FROM records' }), /接管/)
  await invoke(route, { method: 'POST', body: { action: 'shared-query-control', id: connected.id, controller: 'ai' } })
  const write = JSON.parse(await exec(tools.get('database_execute_sql'), { ...args, sql: 'INSERT INTO records (id) VALUES (1)' }))
  assert.equal(write.status, 'succeeded')
  const controller = new AbortController()
  const pending = exec(tools.get('database_execute_sql'), { ...args, sql: 'SELECT id FROM records WHERE note = \'SLEEP_TEST\'' }, { signal: controller.signal, callId: 'busy-1' })
  await new Promise(resolve => setTimeout(resolve, 40))
  const during = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'shared-query-get', id: connected.id } })).body)
  assert.equal(during.sharedQuery.sql.includes('SLEEP_TEST'), true)
  const waited = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'execution-wait', revision: 0 } })).body)
  assert.ok((waited.events || []).some(event => event.type === 'QUERY_CHANGED' && String(event.sql || '').includes('SLEEP_TEST')))
  await assert.rejects(exec(tools.get('database_execute_sql'), { ...args, sql: 'SELECT id FROM records' }, { callId: 'busy-2' }), /已有查询/)
  await invoke(route, { method: 'POST', body: { action: 'shared-query-update', id: connected.id, source: 'user', patch: { sql: 'SELECT taken' } } })
  const lost = JSON.parse(await pending)
  assert.equal(lost.controlLost, true)
  assert.ok(lost.rows)
})

test('AI verify COUNT does not overwrite published result SQL or lastRun', async t => {
  const { routes, tools } = fixture(t)
  const route = routes.get('/plugins/database/connections')
  const connected = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'connect', input } })).body)
  const args = { connectionId: connected.id, generation: connected.generation, schema: 'app' }
  const first = JSON.parse(await exec(tools.get('database_execute_sql'), { ...args, sql: 'SELECT id, note FROM records', limit: 10 }))
  assert.equal(first.rowCount, 1)
  const afterSelect = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'shared-query-get', id: connected.id } })).body)
  assert.equal(afterSelect.sharedQuery.sql.includes('SELECT id, note FROM records'), true)
  const publishedId = afterSelect.sharedQuery.lastExecutionId
  const counted = JSON.parse(await exec(tools.get('database_execute_sql'), { ...args, sql: 'SELECT COUNT(*) FROM records' }))
  assert.equal(counted.rowCount, 1)
  const afterCount = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'shared-query-get', id: connected.id } })).body)
  assert.equal(afterCount.sharedQuery.sql.includes('SELECT COUNT(*) FROM records'), true)
  assert.equal(afterCount.sharedQuery.lastExecutionId, publishedId)
  const publishedCount = JSON.parse(await exec(tools.get('database_execute_sql'), { ...args, sql: 'SELECT COUNT(*) FROM records', purpose: 'result' }))
  assert.equal(publishedCount.rowCount, 1)
  const afterPublish = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'shared-query-get', id: connected.id } })).body)
  assert.equal(afterPublish.sharedQuery.sql.includes('SELECT COUNT(*) FROM records'), true)
  assert.notEqual(afterPublish.sharedQuery.lastExecutionId, publishedId)
  await exec(tools.get('database_execute_sql'), { ...args, sql: 'SELECT id, note FROM records', purpose: 'verify' })
  const afterHidden = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'shared-query-get', id: connected.id } })).body)
  assert.equal(afterHidden.sharedQuery.sql.includes('SELECT id, note FROM records'), true)
  assert.equal(afterHidden.sharedQuery.lastExecutionId, afterPublish.sharedQuery.lastExecutionId)
})

test('verify queries do not occupy the per-connection run lock', async t => {
  const { routes, tools } = fixture(t)
  const route = routes.get('/plugins/database/connections')
  const connected = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'connect', input } })).body)
  const args = { connectionId: connected.id, generation: connected.generation, schema: 'app' }
  const controller = new AbortController()
  const pending = exec(tools.get('database_execute_sql'), { ...args, sql: 'SELECT id FROM records WHERE note = \'SLEEP_TEST\'', purpose: 'verify' }, { signal: controller.signal, callId: 'verify-slow' })
  await new Promise(resolve => setTimeout(resolve, 40))
  const during = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'shared-query-get', id: connected.id } })).body)
  assert.equal((during.sharedQuery.sql || '').includes('SLEEP_TEST'), true)
  const result = JSON.parse(await exec(tools.get('database_execute_sql'), { ...args, sql: 'SELECT id FROM records', purpose: 'result' }, { callId: 'result-during-verify' }))
  assert.equal(result.ok, true)
  controller.abort()
  await pending.catch(() => {})
})

test('SIT query returns raw cell values without redaction', async t => {
  const oldHome = process.env.DSH_HOME
  const directory = temporaryDirectory(t, 'database-ai-rules-')
  process.env.DSH_HOME = directory
  const routes = new Map(), tools = new Map()
  const ctx = {
    sessions: { get: id => id === 'conversation-a' ? { id } : undefined },
    connection: { requestRejection: () => undefined },
    webServer: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } },
    tools: { register: tool => tools.set(tool.name, tool) },
    on() { return () => {} },
  }
  const registration = registerDatabase(ctx, workerUrl, {
    rules: [
      { column: 'id', action: 'allow' },
      { column: 'note', action: 'mask' },
    ],
  })
  t.after(async () => {
    await registration.dispose()
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  })
  const route = routes.get('/plugins/database/connections')
  const connected = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'connect', input } })).body)
  const args = { connectionId: connected.id, generation: connected.generation, schema: 'app' }
  const status = JSON.parse(await exec(tools.get('database_status'), {}))
  assert.equal(status.connections[0].environment, 'sit')
  const queried = JSON.parse(await exec(tools.get('database_execute_sql'), { ...args, sql: 'SELECT id, note FROM records', limit: 10 }))
  assert.deepEqual(queried.rows[0], ['1', 'secret-value'])
  assert.ok(queried.rows.length <= 100)
})

test('execution-latest hydrates the last displayable result for a connection', async t => {
  const { routes, tools } = fixture(t)
  const route = routes.get('/plugins/database/connections')
  const connected = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'connect', input } })).body)
  const args = { connectionId: connected.id, generation: connected.generation, schema: 'app' }
  await invoke(route, { method: 'POST', body: { action: 'shared-query-control', id: connected.id, controller: 'ai' } })
  const queried = JSON.parse(await exec(tools.get('database_execute_sql'), { ...args, sql: 'SELECT id FROM records', limit: 10 }))
  const latest = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'execution-latest', id: connected.id } })).body)
  assert.equal(latest.execution.executionId, queried.executionId)
  assert.equal(latest.execution.queryRevision, queried.executionId ? latest.execution.queryRevision : undefined)
  assert.ok(latest.execution.result.rows)
  const takeover = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'shared-query-control', id: connected.id, controller: 'user', reason: 'user-takeover' } })).body)
  assert.equal(takeover.sharedQuery.controller, 'user')
  const formatted = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'shared-query-update', id: connected.id, source: 'format', patch: { sql: 'SELECT id FROM records' } } })).body)
  assert.equal(formatted.sharedQuery.controller, 'user')
})

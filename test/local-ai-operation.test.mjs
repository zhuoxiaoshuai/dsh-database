import test from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConnectionService } from '../src/host/connection-service.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { registerAiTools } from '../src/host/ai-tools.ts'
import { runLocalAiOperation } from '../src/host/local-ai-operation.ts'
import { temporaryDirectory, connectionInput } from './helpers.mjs'

function fixture(t) {
  const directory = temporaryDirectory(t, 'local-ai-'), store = new ExecutionStore(directory)
  let workerCalls = 0
  const service = new ConnectionService(id => id === 'owner', directory, undefined, undefined, store, undefined,
    () => { workerCalls++; throw new Error('Local tools must not start a Worker') })
  t.after(async () => { await service.dispose(); await store.dispose() })
  const tools = new Map(), events = []
  const emit = store.emitWorkbench.bind(store)
  store.emitWorkbench = (owner, event) => { events.push(event); emit(owner, event) }
  registerAiTools({ tools: { register: tool => tools.set(tool.name, tool) } }, service, store, id => id === 'owner')
  const run = async (name, args, extra = {}) => JSON.parse(await tools.get(name).execute(args, {
    agent: { session: { id: 'owner' } }, callId: 'local-call', rootCallId: 'local-root', ...extra,
  }))
  const imported = dialect => service.importConnections('owner', [{ ...connectionInput({ dialect }), password: undefined }]).created[0]
  return { directory, store, service, run, imported, events, workerCalls: () => workerCalls }
}
function recordFor(f, result) {
  const record = f.store.get('owner', result.executionId)
  assert.ok(record); assert.equal(record.status, 'succeeded')
  assert.equal(record.type, 'tool'); assert.equal(record.historyVisible, false)
  assert.equal(record.callId, 'local-call'); assert.equal(record.rootCallId, 'local-root')
  assert.deepEqual(record.events.map(e => e.kind), ['created', 'check-passed', 'result'])
  assert.equal(result.executionStatus, undefined); assert.equal(f.workerCalls(), 0)
  return record
}

for (const dialect of ['mysql', 'oracle']) test(`${dialect} actual local tools preserve five branches, offline storage and output shapes`, async t => {
  const f = fixture(t), { password: _password, ...input } = connectionInput({ dialect })
  const imported = await f.run('database_import_connections', { connections: [input, input] })
  assert.deepEqual(Object.keys(imported).sort(), ['executionId', 'created', 'skipped', 'message'].sort())
  assert.equal(imported.created.length, 1); assert.equal(imported.skipped.length, 1)
  const connection = imported.created[0]
  assert.equal(connection.live, false); assert.equal(connection.hasPassword, false)
  assert.equal(recordFor(f, imported).connectionId, undefined)
  const sql = dialect === 'oracle' ? 'SELECT 1 AS id FROM dual' : 'SELECT 1 AS id'
  const before = f.service.getSharedQuery('owner', connection.connectionId)
  const saved = await f.run('database_templates', { action: 'save', connectionId: connection.connectionId, sql, title: 'local experience', tags: ['local'] })
  assert.deepEqual(Object.keys(saved).sort(), ['executionId', 'id', 'title', 'merged', 'version', 'message'].sort())
  const savedRecord = recordFor(f, saved)
  assert.equal(savedRecord.connectionId, connection.connectionId); assert.equal(savedRecord.dialect, dialect)
  assert.equal(savedRecord.sql, sql)
  const got = await f.run('database_templates', { action: 'get', id: saved.id })
  assert.deepEqual(Object.keys(got).sort(), ['executionId', 'id', 'title', 'summary', 'tags', 'dialect', 'originalSql', 'features', 'version', 'familyId'].sort())
  assert.equal(got.originalSql, sql); assert.equal(got.version, saved.version)
  const gotRecord = recordFor(f, got)
  assert.equal(gotRecord.connectionId, undefined); assert.equal(gotRecord.sql, sql)
  assert.deepEqual(gotRecord.draft, { kind: 'query', sql }); assert.equal(gotRecord.message, undefined)
  const search = await f.run('database_templates', { action: 'search', connectionId: connection.connectionId, query: 'local' })
  assert.deepEqual(Object.keys(search).sort(), ['executionId', 'items'])
  assert.equal(search.items.length, 1); assert.equal(search.items[0].id, saved.id); recordFor(f, search)
  const collab = await f.run('database_read_collab', {})
  assert.deepEqual(Object.keys(collab).sort(), ['executionId', 'items', 'note']); recordFor(f, collab)
  assert.equal(f.store.list('owner').length, 5)
  assert.deepEqual(f.service.getSharedQuery('owner', connection.connectionId), before)
  assert.equal(f.events.filter(e => e.type === 'EXECUTION_FINISHED').length, 0)
  const merged = await f.run('database_templates', { action: 'save', connectionId: connection.connectionId, sql, title: 'local experience updated' })
  assert.equal(merged.id, saved.id); assert.equal(merged.merged, true)
  assert.equal((await f.run('database_templates', { action: 'get', id: saved.id })).version, merged.version)
  const other = f.service.importConnections('owner', [{ ...input, name: 'other', host: 'other.test' }]).created[0]
  assert.equal((await f.run('database_templates', { action: 'search', connectionId: other.id })).items.length, 0)
  f.service.templates.archive(saved.id)
  await assert.rejects(f.run('database_templates', { action: 'get', id: saved.id }), /不存在|归档/)
  assert.equal((await f.run('database_templates', { action: 'search', connectionId: connection.connectionId })).items.length, 0)
  await f.service.templates.ingestUnpublished([sql + ' /* unpublished */'], dialect)
  const unpublished = f.service.templates.list().find(item => item.unpublished)
  assert.ok(unpublished)
  await assert.rejects(f.run('database_templates', { action: 'get', id: unpublished.id }), /未发布/)
  const disk = readFileSync(join(f.directory, 'ai-executions.json'), 'utf8')
  assert.ok(!disk.includes('other.test')); assert.ok(!disk.includes('"features"'))
})

test('local tools preserve record boundaries, absent call IDs and reject invalid identity without work', async t => {
  const f = fixture(t)
  for (const [tool, args] of [['database_templates', {action: 'get'}], ['database_templates', {action: 'save'}], ['database_templates', {action: 'unknown'}]]) {
    await assert.rejects(f.run(tool, args)); assert.equal(f.store.list('owner').length, 0)
  }
  await assert.rejects(f.run('database_read_collab', {}, { agent: {session: {id: 'other'}} }))
  assert.equal(f.store.list('owner').length, 0)
  await assert.rejects(f.run('database_templates', {action: 'get', id: 'missing'}))
  assert.equal(f.store.list('owner').length, 1)
  assert.equal(f.store.list('owner')[0].status, 'failed')
  assert.deepEqual(f.store.list('owner')[0].events.map(e => e.kind), ['created', 'result'])
  const read = await f.run('database_read_collab', {}, {callId: undefined, rootCallId: undefined})
  assert.equal(f.store.get('owner', read.executionId).callId, '')
  assert.equal(f.store.get('owner', read.executionId).rootCallId, '')
  const count = f.store.list('owner').length
  await f.run('database_status', {})
  assert.equal(f.store.list('owner').length, count)
})

for (const name of ['database_import_connections', 'database_templates', 'database_read_collab']) test(`pre-aborted ${name} performs no business work`, async t => {
  const f = fixture(t), connection = f.imported('mysql'), signal = AbortSignal.abort()
  const before = f.service.snapshot('owner')
  const { password: _password, ...importInput } = connectionInput({host: 'never.test'})
  const args = name === 'database_templates' ? {action: 'save', connectionId: connection.id, title: 'not saved', sql: 'SELECT 1'} :
    name === 'database_import_connections' ? {connections: [importInput]} : {}
  await assert.rejects(f.run(name, args, {signal}), /取消/)
  assert.equal(f.store.list('owner').length, 0)
  assert.equal(f.service.templates.list().length, 0)
  assert.deepEqual(f.service.snapshot('owner'), before)
})

for (const cancel of ['external', 'record', 'conversation']) test(`delayed real save preserves committed result after ${cancel} without replay`, { timeout: 5000 }, async t => {
  const f = fixture(t), connection = f.imported('mysql'), external = new AbortController()
  const release = Promise.withResolvers(), committed = Promise.withResolvers()
  const publish = f.service.templates.publishFromSql.bind(f.service.templates)
  let writes = 0
  f.service.templates.publishFromSql = async input => { writes++; const value = await publish(input); committed.resolve(value); await release.promise; return value }
  const pending = f.run('database_templates', { action: 'save', connectionId: connection.id, sql: 'SELECT 42 AS id', title: 'committed' }, {signal: external.signal})
  const saved = await committed.promise
  const [running] = f.store.list('owner')
  assert.equal(running.status, 'running')
  if (cancel === 'external') external.abort()
  if (cancel === 'record') f.store.cancel('owner', running.executionId, false)
  if (cancel === 'conversation') f.store.cancelConversation('owner', '当前对话已失效')
  release.resolve()
  const value = await pending
  assert.equal(value.id, saved.id); assert.equal(value.executionStatus, undefined)
  assert.equal(writes, 1); assert.equal(f.service.templates.list().length, 1)
  const record = f.store.get('owner', value.executionId)
  assert.equal(record.status, cancel === 'external' ? 'succeeded' : cancel === 'record' ? 'cancelled' : 'unknown')
  assert.equal(record.events.filter(e => e.kind === 'dispatched').length, 0)
  assert.equal(getEventListeners(external.signal, 'abort').length, 0)
})

for (const [message, status, event] of [['ordinary failure password=SECRET_CANARY', 'failed'], ['查询超过 32 秒，已超时', 'failed'], ['request timeout', 'unknown', 'timeout'], ['连接已变化', 'unknown', 'disconnect'], ['请求已取消', 'cancelled']]) {
  test(`local failure retains classification: ${status}/${event || 'none'}`, async t => {
    const f = fixture(t), external = new AbortController()
    const native = message.includes('SECRET_CANARY')
    await assert.rejects(runLocalAiOperation(f.store, {signal: external.signal}, 'owner', undefined, 'database_templates', {title: 'safe'}, async () => { throw new Error(message) }), error => error.message.includes('SECRET_CANARY') === native)
    const [record] = f.store.list('owner')
    assert.equal(record.status, status)
    if (event) assert.equal(record.events.filter(e => e.kind === event).length, 1)
    assert.equal(getEventListeners(external.signal, 'abort').length, 0)
    assert.equal(readFileSync(join(f.directory, 'ai-executions.json'), 'utf8').includes('SECRET_CANARY'), native)
  })
}

for (const mechanism of ['none', 'plain', 'scram-sha-256', 'scram-sha-512']) test(`Kafka import schema and Host accept ${mechanism}, offline and credential free`, async t => {
  const f = fixture(t)
  const input = { dialect: 'kafka', brokers: ['BROKER.test:9092', '[::1]:9093'], tls: true, saslMechanism: mechanism, username: 'user', environment: 'uat' }
  const imported = await f.run('database_import_connections', { connections: [input, input] })
  assert.equal(imported.created.length, 1); assert.equal(imported.skipped[0].reason, 'duplicate')
  assert.deepEqual(imported.created[0].brokers, ['[::1]:9093', 'broker.test:9092'])
  assert.equal(imported.created[0].tls, true); assert.equal(imported.created[0].saslMechanism, mechanism)
  assert.equal(imported.created[0].username, mechanism === 'none' ? '' : 'user')
  assert.equal(imported.created[0].environment, 'uat'); assert.equal(imported.created[0].live, false)
  recordFor(f, imported)
  const invalid = await f.run('database_import_connections', { connections: [
    { dialect: 'kafka', brokers: ['http://host:9092'] }, { dialect: 'kafka' },
    { dialect: 'kafka', brokers: ['host:9092'], saslMechanism: 'plain' },
  ] })
  assert.equal(invalid.created.length, 0); assert.equal(invalid.skipped.length, 3)
  for (const field of ['password', 'privateKey', 'caPem']) await assert.rejects(f.run('database_import_connections', { connections: [{ ...input, [field]: 'secret-marker' }] }), new RegExp(field))
  assert.equal(JSON.stringify(f.service.snapshot('owner')).includes('secret-marker'), false)
  assert.equal(f.workerCalls(), 0)
})
test('mixed source import enforces total connection count without opening a Worker', async t => {
  const f = fixture(t)
  const mysql = { dialect: 'mysql', host: 'mysql.test', port: 3306, username: 'reader' }
  const kafka = n => ({ dialect: 'kafka', brokers: [`broker-${n}.test:9092`] })
  assert.equal((await f.run('database_import_connections', { connections: [mysql, kafka(0)] })).created.length, 2)
  f.service.importConnections('owner', Array.from({ length: 50 }, (_, n) => kafka(n + 1)))
  f.service.importConnections('owner', Array.from({ length: 48 }, (_, n) => kafka(n + 51)))
  const overflow = await f.run('database_import_connections', { connections: [kafka(100)] })
  assert.equal(overflow.created.length, 0); assert.match(overflow.skipped[0].message, /上限/)
  assert.equal(f.service.list('owner').length, 100); assert.equal(f.workerCalls(), 0)
})


test('saved SQL experience operations accept offline connections without a generation', async t => {
  const f = fixture(t), connection = f.imported('mysql')
  assert.equal(connection.live, false)
  assert.equal(connection.generation, undefined)
  const saved = await f.run('database_templates', { action: 'save', connectionId: connection.id, title: 'offline', sql: 'SELECT 7' })
  assert.ok(saved.id)
  const found = await f.run('database_templates', { action: 'search', connectionId: connection.id, query: 'offline' })
  assert.equal(found.items[0].id, saved.id)
  assert.equal(f.workerCalls(), 0)
  const query = await f.run('database_execute_sql', { connectionId: connection.id, sql: 'SELECT 7', schema: 'app' })
  assert.equal(query.ok, false)
  assert.match(query.error, /连接/)
  assert.equal(f.workerCalls(), 0)
})

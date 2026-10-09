import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { getRedisDataSource } from '../src/host/data-sources/registry.mjs'
import { ConnectionService } from '../src/host/connection-service.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { SavedDatabaseConnections } from '../src/host/saved-connections.ts'
import { registerRedisAiTools } from '../src/host/redis-ai-tools.ts'
import { redisPreparedInput } from '../src/host/redis-request.ts'
import { redisExecution } from '../src/host/data-sources/redis/execution.ts'
import { prepareRedisReadOperation } from '../src/host/data-sources/redis/read-operation.ts'
import { createHash } from 'node:crypto'
import { EXECUTION_API_ACTIONS } from '../src/shared/database-actions.ts'
import { controlExecutionDocument, emptyExecutionDocument, updateExecutionDocument } from '../src/shared/execution-document.ts'
import { connectionInput, temporaryDirectory } from './helpers.mjs'

const home = { host: '127.0.0.1', port: 6379, database: '4', redisMode: 'standalone' }

async function readFixture(t, environment = 'sit', workerFactory) {
  const directory = temporaryDirectory(t, 'redis-read-')
  const marker = join(directory, 'dispatch.jsonl')
  const executions = new ExecutionStore(directory)
  let worker
  const service = new ConnectionService(() => true, directory, undefined, undefined, executions, undefined,
    () => { worker = workerFactory ? workerFactory(marker) : new Worker(new URL('./fixtures/redis-queue-worker.mjs', import.meta.url), { workerData: { marker, blockUntilReleased: true } }); return worker })
  t.after(async () => { await service.dispose(); executions.dispose() })
  const connection = await service.open('owner', connectionInput({ dialect: 'redis', database: '4', port: 6379, environment }), false)
  const tools = new Map()
  registerRedisAiTools({ tools: { register(tool) { tools.set(tool.name, tool) } } }, service, executions, id => id === 'owner')
  const events = [], emit = executions.emitWorkbench.bind(executions)
  executions.emitWorkbench = (owner, event) => { events.push(event); emit(owner, event) }
  const invoke = (operation, input = {}, signal) => tools.get(operation).execute({ connectionId: connection.id, generation: connection.generation, ...input },
    { agent: { session: { id: 'owner' } }, callId: 'read-call', rootCallId: 'read-root', signal })
  const dispatched = () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  return { directory, marker, executions, service, connection, events, invoke, dispatched, releaseBlocks: () => { try { worker.postMessage({ fixtureRelease: true }) } catch { /* old generation terminated */ } } }
}
async function waitFor(check) {
  const until = Date.now() + 5000
  while (!check()) { assert.ok(Date.now() < until, 'fixture wait timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
}

for (const operation of ['redis_keys', 'redis_value']) for (const change of ['takeover', 'text', 'database', 'generation', 'cancel']) test(`queued ${operation} rejects ${change} without dispatch and keeps one record`, async t => {
  const f = await readFixture(t)
  const blockers = Array.from({ length: 3 }, () => f.service.redisRequest('owner', f.connection.id, f.connection.generation, 'redis-command', { command: 'BLOCK' }))
  await waitFor(() => f.dispatched().length === 3)
  const abort = new AbortController()
  const pending = f.invoke(operation, operation === 'redis_keys' ? { match: 'private:queued:*' } : { key: 'private:queued:key' }, abort.signal)
  const rejected = assert.rejects(pending)
  const record = f.executions.list('owner').find(item => item.operation === operation)
  assert.equal(record.status, 'checking')
  assert.equal(record.events.filter(e => e.kind === 'dispatched').length, 0)
  if (change === 'takeover') f.service.controlExecutionDocument('owner', f.connection.id, 'user', undefined, f.connection.generation, f.service.getExecutionDocument('owner', f.connection.id).revision)
  if (change === 'text') f.service.updateExecutionDocument('owner', f.connection.id, 'GET other', 'ai', f.service.getExecutionDocument('owner', f.connection.id).revision, f.connection.generation)
  if (change === 'database') f.service.patchExecutionDocumentContext('owner', f.connection.id, '1', f.connection.generation, f.service.getExecutionDocument('owner', f.connection.id).revision)
  if (change === 'generation') await f.service.open('owner', connectionInput({ dialect: 'redis', database: '1', port: 6379 }), false, f.connection.id)
  if (change === 'cancel') abort.abort()
  f.releaseBlocks()
  await Promise.allSettled(blockers); await rejected
  const records = f.executions.list('owner').filter(item => item.operation === operation)
  assert.equal(records.length, 1)
  assert.ok(['failed', 'cancelled'].includes(records[0].status))
  assert.equal(records[0].events.filter(e => e.kind === 'dispatched').length, 0)
  assert.equal(f.dispatched().filter(item => item.action === 'redis-scan' || item.action === 'redis-key').length, 0)
})

for (const environment of ['sit', 'uat', 'pvt']) test(`Redis read tools preserve ${environment} output, target, history and document`, async t => {
  const f = await readFixture(t, environment)
  f.service.patchExecutionDocumentContext('owner', f.connection.id, '2', f.connection.generation, f.service.getExecutionDocument('owner', f.connection.id).revision)
  f.events.length = 0
  const document = f.service.getExecutionDocument('owner', f.connection.id)
  const scan = JSON.parse(await f.invoke('redis_keys', { cursor: '5', match: 'private:pattern:*' }))
  const value = JSON.parse(await f.invoke('redis_value', { key: 'private:key', offset: 7 }))
  assert.deepEqual(scan.keys, ['fixture:key']); assert.equal(value.keyType, 'string')
  assert.equal(value.value.result.value, 'SECRET_PAYLOAD')
  assert.ok(scan.executionId && value.executionId)
  assert.equal(scan.executionStatus, undefined); assert.equal(value.executionStatus, undefined)
  const records = f.executions.list('owner')
  assert.equal(records.length, 2)
  assert.ok(records.every(item => item.type === 'tool' && item.initiator === 'ai' && item.historyVisible && item.callId === 'read-call' && item.rootCallId === 'read-root' && item.status === 'succeeded' && item.events.filter(e => e.kind === 'dispatched').length === 1))
  assert.equal(records.find(item => item.operation === 'redis_value').title, `Redis READ · Key ${createHash('sha256').update('private:key').digest('hex').slice(0, 12)}`)
  assert.deepEqual(f.service.getExecutionDocument('owner', f.connection.id), document)
  assert.equal(f.events.length, 0)
  assert.ok(f.dispatched().every(item => item.input.database === '2'))
  assert.equal(f.dispatched()[0].input.cursor, '5'); assert.equal(f.dispatched()[1].input.offset, 7)
  const saved = readFileSync(join(f.directory, 'ai-executions.json'), 'utf8')
  for (const secret of ['private:key', 'private:pattern', 'SECRET_PAYLOAD']) assert.ok(!saved.includes(secret))
  if (environment !== 'sit') await assert.rejects(f.invoke('redis_execute', { command: 'PING' }), /不开放/)
})

test('Redis structured adapter rejects unsupported and mutating operations', () => {
  const binding = { database: '0', settings: { redisMode: 'cluster' } }
  assert.throws(() => prepareRedisReadOperation('redis_execute', {}, {}, binding), /尚未开放/)
  assert.throws(() => prepareRedisReadOperation('redis_value', { key: 'key', operation: 'delete' }, {}, binding), /只允许/)
  assert.throws(() => prepareRedisReadOperation('redis_keys', {}, { database: '1' }, binding), /DB 0/)
  assert.throws(() => prepareRedisReadOperation('redis_value', {}, {}, binding), /Key/)
})

for (const operation of ['redis_keys', 'redis_value']) test(`${operation} cancellation and failure use safe summaries without closing other reads`, async t => {
  const f = await readFixture(t)
  const input = selector => operation === 'redis_keys' ? { match: selector } : { key: selector }
  const abort = new AbortController()
  const pending = f.invoke(operation, input('fixture:hang'), abort.signal)
  const rejected = assert.rejects(pending)
  await waitFor(() => f.dispatched().length === 1)
  abort.abort(); await rejected
  assert.equal(f.executions.list('owner')[0].status, 'cancelled')
  await assert.rejects(f.invoke(operation, input('fixture:error-private')), /NOPERM/)
  const failed = f.executions.list('owner').find(item => item.status === 'failed')
  assert.ok(failed)
  assert.ok(JSON.parse(await f.invoke(operation, input('fixture:ok'))).executionId)
  assert.equal(f.service.list('owner')[0].generation, f.connection.generation)
  const saved = readFileSync(join(f.directory, 'ai-executions.json'), 'utf8')
  assert.ok(saved.includes('NOPERM fixture:error-private SECRET_PAYLOAD'))
})

test('read send failure has no dispatched event and cleans Worker listeners', async t => {
  let worker
  const f = await readFixture(t, 'sit', marker => {
    worker = new Worker(new URL('./fixtures/redis-queue-worker.mjs', import.meta.url), { workerData: { marker } })
    const send = worker.postMessage.bind(worker)
    worker.postMessage = message => { if (message.action === 'redis-scan') throw new Error('send-failure private-key'); send(message) }
    return worker
  })
  const messages = worker.listenerCount('message'), exits = worker.listenerCount('exit')
  await assert.rejects(f.invoke('redis_keys'), /send-failure/)
  assert.equal(f.executions.list('owner')[0].status, 'failed')
  assert.equal(f.executions.list('owner')[0].events.filter(e => e.kind === 'dispatched').length, 0)
  assert.equal(worker.listenerCount('message'), messages); assert.equal(worker.listenerCount('exit'), exits)
  assert.ok(readFileSync(join(f.directory, 'ai-executions.json'), 'utf8').includes('send-failure private-key'))
})

for (const actor of ['ai', 'user']) for (const change of ['takeover', 'text', 'database', 'generation']) test(`real Redis ${actor} document queue rejects stale ${change} before Worker dispatch`, async t => {
  const directory = temporaryDirectory(t, 'redis-queue-')
  const marker = join(directory, 'dispatch.jsonl')
  const url = new URL('./fixtures/redis-queue-worker.mjs', import.meta.url)
  url.searchParams.set('marker', marker)
  const executions = new ExecutionStore(directory)
  let worker
  const service = new ConnectionService(() => true, directory, undefined, undefined, executions, undefined, () => { worker = new Worker(url, { workerData: { marker, blockUntilReleased: true } }); return worker })
  t.after(() => service.dispose())
  const connection = await service.open('owner', connectionInput({ dialect: 'redis', port: 6379, database: '0', redisMode: 'standalone' }), false)
  const { id, generation } = connection
  const document = service.updateExecutionDocument('owner', id, 'PING', actor, service.getExecutionDocument('owner', id).revision, generation)
  const blockers = Array.from({ length: 3 }, () => service.redisRequest('owner', id, generation, 'redis-command', { command: 'BLOCK' }))
  while (!existsSync(marker) || readFileSync(marker, 'utf8').trim().split('\n').length < 3) await new Promise(resolve => setTimeout(resolve, 5))
  const pending = actor === 'ai'
    ? service.redisRequest('owner', id, generation, 'redis-command', { command: 'PING' }, undefined, 'ai', { queryRevision: document.revision })
    : service.runExecutionDocument('owner', id, generation, document.revision)
  const rejected = assert.rejects(pending)
  if (change === 'takeover') service.controlExecutionDocument('owner', id, actor === 'ai' ? 'user' : 'ai', undefined, generation, service.getExecutionDocument('owner', id).revision)
  if (change === 'text') service.updateExecutionDocument('owner', id, 'GET other', 'user', document.revision, generation)
  if (change === 'database') service.patchExecutionDocumentContext('owner', id, '1', generation, document.revision)
  if (change === 'generation') await service.open('owner', connectionInput({ dialect: 'redis', port: 6379, database: '1', redisMode: 'standalone' }), false, id)
  try { worker.postMessage({ fixtureRelease: true }) } catch { /* old generation terminated */ }
  await Promise.allSettled(blockers)
  await rejected
  const dispatched = readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(dispatched.filter(item => item.input?.args?.[0] === 'PING').length, 0)
  if (actor === 'user') assert.equal(executions.list('owner').filter(item => item.title === 'Redis PING').length, 1, 'the rejected document keeps a single main record')
})

test('redis-command opens the requested database and falls back to the home database', () => {
  const driver = getRedisDataSource('redis').driver
  assert.equal(driver.commandCredentials(home, '2').database, '2')
  assert.equal(driver.commandCredentials(home).database, '4')
  assert.equal(driver.commandCredentials(home, '').database, '4')
  assert.throws(() => driver.commandCredentials({ ...home, database: '0', redisMode: 'cluster' }, '1'), /DB 0/)
  const worker = readFileSync(new URL('../src/host/redis-worker.mjs', import.meta.url), 'utf8')
  assert.match(worker, /commandCredentials\(credentials, message\.input\?\.database\)/)
})

test('host redis-command keeps the validated database instead of dropping it', () => {
  const prepared = redisExecution.prepareText('GET one', { database: '2' }).input
  assert.deepEqual(prepared.args, ['GET', 'one'])
  assert.equal(prepared.database, '2')
  assert.equal(redisExecution.normalizeContext(undefined, { database: '4' }).database, '4')
  assert.equal(redisPreparedInput('redis-scan', { cursor: '0', match: 'a*' }, '3').database, '3')
  assert.throws(() => redisExecution.normalizeContext({ database: 'nope' }, { database: '0' }), /0–65535/)
})

test('shared query confirm is gone and redis context is not a user edit', async t => {
  assert.equal(EXECUTION_API_ACTIONS.includes('shared-query-confirm'), false)
  assert.equal(EXECUTION_API_ACTIONS.includes('execution-document-context'), true)
  assert.equal(existsSync(new URL('../src/approval-ledger.ts', import.meta.url)), false)
  assert.equal(readFileSync(new URL('../src/host/connection-api.ts', import.meta.url), 'utf8').includes('shared-query-confirm'), false)
  const directory = temporaryDirectory(t, 'redis-context-')
  new SavedDatabaseConnections(directory).save({
    connections: [{ id: 'redis-1', settings: connectionInput({ dialect: 'redis', port: 6379, database: '0', redisMode: 'standalone' }) }],
  })
  const service = new ConnectionService(() => true, directory)
  t.after(async () => { await service.dispose() })
  const initial = service.getExecutionDocument('owner', 'redis-1')
  const patched = service.patchExecutionDocumentContext('owner', 'redis-1', '3', undefined, service.getExecutionDocument('owner', 'redis-1').revision)
  assert.equal(patched.context.database, '3')
  assert.equal(patched.text, initial.text)
  assert.equal(patched.revision, initial.revision + 1)
  assert.equal(patched.controller, 'ai')
  assert.deepEqual(service.patchExecutionDocumentContext('owner', 'redis-1', '3', undefined, service.getExecutionDocument('owner', 'redis-1').revision), patched)
  const clusterDirectory = temporaryDirectory(t, 'redis-cluster-')
  new SavedDatabaseConnections(clusterDirectory).save({
    connections: [{ id: 'redis-cluster', settings: connectionInput({ dialect: 'redis', port: 6379, database: '0', redisMode: 'cluster' }) }],
  })
  const cluster = new ConnectionService(() => true, clusterDirectory)
  t.after(async () => { await cluster.dispose() })
  assert.throws(() => cluster.patchExecutionDocumentContext('owner', 'redis-cluster', '1', undefined, cluster.getExecutionDocument('owner', 'redis-cluster').revision), /DB 0/)
})

test('all Redis command entrypoints share one record, safe history and one document event', async t => {
  const directory = temporaryDirectory(t, 'redis-standard-')
  const marker = join(directory, 'dispatch.jsonl')
  const executions = new ExecutionStore(directory)
  const service = new ConnectionService(() => true, directory, undefined, undefined, executions, undefined,
    () => new Worker(new URL('./fixtures/redis-queue-worker.mjs', import.meta.url), { workerData: { marker } }))
  t.after(() => service.dispose())
  const connection = await service.open('owner', connectionInput({ dialect: 'redis', database: '4', port: 6379 }), false)
  const events = []
  const emit = executions.emitWorkbench.bind(executions)
  executions.emitWorkbench = (owner, event) => { events.push(event); emit(owner, event) }
  await service.redisRequest('owner', connection.id, connection.generation, 'redis-command', { command: 'GET secret-key' })
  await service.executeText('owner', connection.id, connection.generation, 'GET secret-key', undefined, 'user', undefined, undefined, undefined, { database: '2' })
  const document = service.updateExecutionDocument('owner', connection.id, 'GET secret-key', 'user', service.getExecutionDocument('owner', connection.id).revision, connection.generation)
  await service.runExecutionDocument('owner', connection.id, connection.generation, document.revision)
  service.controlExecutionDocument('owner', connection.id, 'ai', undefined, connection.generation, service.getExecutionDocument('owner', connection.id).revision)
  const tools = []
  registerRedisAiTools({ tools: { register(tool) { tools.push(tool) } } }, service, executions, () => true)
  const result = JSON.parse(await tools.find(tool => tool.name === 'redis_execute').execute({ connectionId: connection.id, generation: connection.generation, command: 'GET secret-key' }, { agent: { session: { id: 'owner' } }, callId: 'call', rootCallId: 'root' }))
  const records = executions.list('owner')
  assert.equal(records.length, 4)
  assert.ok(records.every(item => item.operation === 'redis_execute' && item.events.filter(e => e.kind === 'dispatched').length === 1))
  const ai = records.find(item => item.executionId === result.executionId)
  assert.equal(ai.type, 'tool'); assert.equal(ai.callId, 'call'); assert.equal(ai.rootCallId, 'root')
  assert.ok(records.filter(item => item.initiator === 'user').every(item => item.type === 'query'))
  assert.equal(events.filter(event => event.type === 'EXECUTION_FINISHED').length, 2)
  assert.ok(!readFileSync(join(directory, 'ai-executions.json'), 'utf8').includes('secret-key'))
  const dispatched = readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(dispatched[0].input.database, '4', 'old action uses saved default DB')
  assert.equal(dispatched[1].input.database, '2', 'standard text uses captured context')
})

for (const failure of ['HANG', 'TIMEOUT', 'EXIT']) test(`Redis dispatched ${failure} is unknown, sent once and never replayed`, async t => {
  const directory = temporaryDirectory(t, 'redis-interruption-')
  const marker = join(directory, 'dispatch.jsonl')
  const executions = new ExecutionStore(directory)
  const service = new ConnectionService(() => true, directory, undefined, undefined, executions, undefined,
    () => new Worker(new URL('./fixtures/redis-queue-worker.mjs', import.meta.url), { workerData: { marker } }))
  t.after(() => service.dispose())
  const connection = await service.open('owner', connectionInput({ dialect: 'redis', database: '0', port: 6379 }), false)
  const controller = new AbortController()
  const events = []
  const emit = executions.emitWorkbench.bind(executions)
  executions.emitWorkbench = (owner, event) => { events.push(event); emit(owner, event) }
  const document = service.updateExecutionDocument('owner', connection.id, failure, 'user', service.getExecutionDocument('owner', connection.id).revision, connection.generation)
  const pending = service.executeText('owner', connection.id, connection.generation, failure, controller.signal, 'user', undefined, document.revision, undefined, document.context)
  const rejected = assert.rejects(pending)
  while (!existsSync(marker)) await new Promise(done => setTimeout(done, 5))
  if (failure === 'HANG') controller.abort()
  await rejected
  assert.equal(executions.list('owner')[0].status, 'unknown')
  const finished = events.filter(event => event.type === 'EXECUTION_FINISHED')
  if (failure === 'EXIT') assert.equal(finished.length, 0, 'retired worker cannot install a current result; its history remains unknown')
  else {
    assert.equal(finished.length, 1)
    assert.equal(finished[0].status, 'unknown')
    assert.equal(finished[0].sourceResult.executionStatus, 'unknown')
  }
  assert.equal(readFileSync(marker, 'utf8').trim().split('\n').length, 1)
})

test('Redis tools return live connections when the handle is missing, stale, or ambiguous', async () => {
  const tools = new Map()
  const connections = [
    { id: 'r1', dialect: 'redis', generation: 'g1', live: true, name: 'one', environment: 'sit', database: '0', version: '' },
    { id: 'r2', dialect: 'redis', generation: 'g2', live: true, name: 'two', environment: 'sit', database: '0', version: '' },
  ]
  const service = {
    list: () => connections,
    getExecutionDocument: () => ({ controller: 'ai', revision: 1, text: '' }),
    executeRedisReadTool: async (_session, id, generation) => ({ id, generation, keys: [] }),
  }
  registerRedisAiTools({ tools: { register(tool) { tools.set(tool.name, tool) } } }, service, {}, id => id === 'owner')
  const execution = { agent: { session: { id: 'owner' } }, callId: 'c', rootCallId: 'r', signal: new AbortController().signal }
  const ambiguous = JSON.parse(await tools.get('redis_keys').execute({}, execution))
  assert.equal(ambiguous.ok, false)
  assert.equal(ambiguous.connections.length, 2)
  assert.match(ambiguous.help, /redis_status/)
  const stale = JSON.parse(await tools.get('redis_value').execute({ connectionId: 'r1', generation: 'old', key: 'k' }, execution))
  assert.equal(stale.ok, false)
  assert.equal(stale.connections.find(item => item.connectionId === 'r1').generation, 'g1')
  connections.pop()
  const omitted = JSON.parse(await tools.get('redis_keys').execute({}, execution))
  assert.equal(omitted.id, 'r1')
  assert.equal(omitted.generation, 'g1')
})

test('Redis definite error remains failed and module authorization preserves environment/blacklist rules', () => {
  const prepared = redisExecution.prepareText('CONFIG GET secret', { database: '0' })
  assert.equal(prepared.classifyResult({ failed: true }), 'failed')
  for (const environment of ['sit', 'uat', 'pvt']) redisExecution.authorize(prepared, 'user', { environment })
  redisExecution.authorize(prepared, 'ai', { environment: 'sit' })
  for (const environment of ['uat', 'pvt']) assert.throws(() => redisExecution.authorize(prepared, 'ai', { environment }), /不开放/)
  const previous = process.env.DSH_REDIS_COMMAND_BLACKLIST
  try {
    process.env.DSH_REDIS_COMMAND_BLACKLIST = '["FLUSHALL", ["CONFIG", "GET"]]'
    assert.throws(() => redisExecution.authorize(prepared, 'user', { environment: 'sit' }), /禁止/)
  } finally { if (previous === undefined) delete process.env.DSH_REDIS_COMMAND_BLACKLIST; else process.env.DSH_REDIS_COMMAND_BLACKLIST = previous }
})

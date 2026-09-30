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
import { recordUserRedisCommand, redisAiDispatchAllowed, redisCommandRecordsHistory, redisPreparedInput } from '../src/host/redis-request.ts'
import { EXECUTION_API_ACTIONS } from '../src/shared/database-actions.ts'
import { controlExecutionDocument, emptyExecutionDocument, updateExecutionDocument } from '../src/shared/execution-document.ts'
import { connectionInput, temporaryDirectory } from './helpers.mjs'

const home = { host: '127.0.0.1', port: 6379, database: '4', redisMode: 'standalone' }

for (const actor of ['ai', 'user']) for (const change of ['takeover', 'text', 'database', 'generation']) test(`real Redis ${actor} document queue rejects stale ${change} before Worker dispatch`, async t => {
  const directory = temporaryDirectory(t, 'redis-queue-')
  const marker = join(directory, 'dispatch.jsonl')
  const url = new URL('./fixtures/redis-queue-worker.mjs', import.meta.url)
  url.searchParams.set('marker', marker)
  const executions = new ExecutionStore(directory)
  const service = new ConnectionService(() => true, directory, undefined, undefined, executions, undefined, () => new Worker(url, { workerData: { marker } }))
  t.after(() => service.dispose())
  const connection = await service.open('owner', connectionInput({ dialect: 'redis', port: 6379, database: '0', redisMode: 'standalone' }), false)
  const { id, generation } = connection
  const document = service.updateExecutionDocument('owner', id, 'PING', actor, undefined, generation)
  const blockers = Array.from({ length: 3 }, () => service.redisRequest('owner', id, generation, 'redis-command', { command: 'BLOCK' }))
  while (!existsSync(marker) || readFileSync(marker, 'utf8').trim().split('\n').length < 3) await new Promise(resolve => setTimeout(resolve, 5))
  const pending = actor === 'ai'
    ? service.redisRequest('owner', id, generation, 'redis-command', { command: 'PING' }, undefined, 'ai', { queryRevision: document.revision })
    : service.runExecutionDocument('owner', id, generation, document.revision)
  const rejected = assert.rejects(pending)
  if (change === 'takeover') service.controlExecutionDocument('owner', id, actor === 'ai' ? 'user' : 'ai', undefined, generation)
  if (change === 'text') service.updateExecutionDocument('owner', id, 'GET other', 'user', document.revision, generation)
  if (change === 'database') service.patchExecutionDocumentContext('owner', id, '1', generation, document.revision)
  if (change === 'generation') await service.open('owner', connectionInput({ dialect: 'redis', port: 6379, database: '1', redisMode: 'standalone' }), false, id)
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
  const prepared = redisPreparedInput('redis-command', { command: 'GET one' }, '2')
  assert.deepEqual(prepared.args, ['GET', 'one'])
  assert.equal(prepared.database, '2')
  assert.equal(Object.hasOwn(redisPreparedInput('redis-command', { command: 'PING' }, undefined), 'database'), false)
  assert.equal(redisPreparedInput('redis-scan', { cursor: '0', match: 'a*' }, '3').database, '3')
  assert.throws(() => redisPreparedInput('redis-command', { command: 'PING' }, 'nope'), /0–65535/)
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
  const patched = service.patchExecutionDocumentContext('owner', 'redis-1', '3')
  assert.equal(patched.context.database, '3')
  assert.equal(patched.text, initial.text)
  assert.equal(patched.revision, initial.revision + 1)
  assert.equal(patched.controller, 'ai')
  assert.deepEqual(service.patchExecutionDocumentContext('owner', 'redis-1', '3'), patched)
  const clusterDirectory = temporaryDirectory(t, 'redis-cluster-')
  new SavedDatabaseConnections(clusterDirectory).save({
    connections: [{ id: 'redis-cluster', settings: connectionInput({ dialect: 'redis', port: 6379, database: '0', redisMode: 'cluster' }) }],
  })
  const cluster = new ConnectionService(() => true, clusterDirectory)
  t.after(async () => { await cluster.dispose() })
  assert.throws(() => cluster.patchExecutionDocumentContext('owner', 'redis-cluster', '1'), /DB 0/)
})

test('ai redis execute is not sent after takeover or a text change, and records once', async t => {
  const published = updateExecutionDocument(emptyExecutionDocument('redis', { database: '2' }), 'PING', 'ai', 1)
  assert.throws(() => redisAiDispatchAllowed(controlExecutionDocument(published, 'user'), published.revision, 'PING'), /没有发出/)
  assert.throws(() => redisAiDispatchAllowed({ ...published, text: 'GET one' }, published.revision, 'PING'), /没有发出/)
  redisAiDispatchAllowed(published, published.revision, 'PING')
  assert.equal(redisCommandRecordsHistory('redis-command', 'user'), true)
  assert.equal(redisCommandRecordsHistory('redis-command', 'user', false), false)
  assert.equal(redisCommandRecordsHistory('redis-command', 'ai'), false)
  assert.equal(redisCommandRecordsHistory('redis-scan', 'user'), false)
  assert.equal(redisCommandRecordsHistory('redis-key', 'user'), false)

  const directory = temporaryDirectory(t, 'redis-history-')
  const executions = new ExecutionStore(directory)
  const recorded = await recordUserRedisCommand(executions, {
    owner: 'owner', connectionId: 'redis-1', generation: 'g1', connectionName: 'local', sourceId: 'redis', environment: 'sit',
  }, 'PING', async () => ({ result: { type: 'string', value: 'PONG' } }))
  assert.equal(executions.list('owner').length, 1)
  assert.equal(executions.list('owner')[0].executionId, recorded.executionId)
  assert.equal(executions.list('owner')[0].initiator, 'user')
  assert.equal(executions.list('owner')[0].operation, 'redis_execute')
  assert.equal(executions.list('owner')[0].historyVisible, true)

  let document = emptyExecutionDocument('redis', { database: '2' })
  let dispatched = 0
  let block = ''
  const service = {
    list() {
      return [{ id: 'redis-1', dialect: 'redis', live: true, generation: 'g1', name: 'local', environment: 'sit', database: '0' }]
    },
    getExecutionDocument() { return document },
    updateExecutionDocument(_session, _id, text, source, revision) {
      document = updateExecutionDocument(document, text, source, revision)
      return document
    },
    async redisRequest(_session, _id, _generation, _action, input, _signal, initiator, options) {
      assert.equal(initiator, 'ai')
      if (block === 'takeover') document = controlExecutionDocument(document, 'user')
      if (block === 'text') document = updateExecutionDocument(document, 'GET other', 'user', document.revision)
      redisAiDispatchAllowed(document, options.queryRevision, String(input.command || ''))
      assert.equal(document.context.database, '2')
      dispatched += 1
      return { ok: true }
    },
  }
  const tools = []
  registerRedisAiTools({ tools: { register(tool) { tools.push(tool) } } }, service, executions, () => true)
  const execute = tools.find(tool => tool.name === 'redis_execute')
  const call = { agent: { session: { id: 'owner' } }, callId: 'call-1' }
  await execute.execute({ connectionId: 'redis-1', generation: 'g1', command: 'PING' }, call)
  assert.equal(dispatched, 1)
  assert.equal(executions.list('owner').filter(item => item.initiator === 'ai' && item.operation === 'redis_execute').length, 1)

  block = 'takeover'
  await assert.rejects(execute.execute({ connectionId: 'redis-1', generation: 'g1', command: 'PING' }, call), /没有发出/)
  assert.equal(dispatched, 1)
  document = updateExecutionDocument(emptyExecutionDocument('redis', { database: '2' }), 'PING', 'ai', 1)
  block = 'text'
  await assert.rejects(execute.execute({ connectionId: 'redis-1', generation: 'g1', command: 'PING' }, call), /没有发出/)
  assert.equal(dispatched, 1)
  assert.equal(executions.list('owner').filter(item => item.operation === 'redis_execute' && item.initiator === 'ai').length, 3)
  const host = readFileSync(new URL('../src/host/connection-service.ts', import.meta.url), 'utf8')
  const method = host.slice(host.indexOf('async redisRequest'), host.indexOf('async executeText'))
  assert.ok(method.includes('redisAiDispatchAllowed'))
  assert.ok(method.includes('recordUserRedisCommand'))
  assert.ok(method.indexOf('redisAiDispatchAllowed') < method.indexOf('this.#dispatch'))
})

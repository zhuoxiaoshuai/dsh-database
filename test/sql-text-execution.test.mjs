import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareTextOperation, authorizeTextOperation, dispatchTextOperation } from '../src/host/text-execution.ts'
import { createSqlTextExecution } from '../src/host/data-sources/sql-execution.ts'
import { ConnectionService } from '../src/host/connection-service.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { connectionApi } from '../src/host/connection-api.ts'
import { Worker } from 'node:worker_threads'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { executeSql } from '../src/host/query.mjs'
import { temporaryDirectory, connectionInput } from './helpers.mjs'

async function serviceFixture(t, dialect = 'mysql') {
  const directory = temporaryDirectory(t, 'sql-text-'), marker = join(directory, 'dispatch.jsonl'), executions = new ExecutionStore(directory)
  let worker
  const service = new ConnectionService(() => true, directory, undefined, undefined, executions, undefined, () => {
    worker = new Worker(new URL('./fixtures/sql-operation-worker.mjs', import.meta.url), { workerData: { marker } }); return worker
  })
  t.after(async () => { await service.dispose(); await executions.dispose() })
  const connection = await service.open('owner', connectionInput({ dialect }), false)
  const sent = () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  const api = async body => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'; req.headers = { 'content-type': 'application/json' }
    const res = new EventEmitter(); res.destroyed = false; res.writeHead = status => { res.status = status }
    res.end = body => { res.writableEnded = true; res.body = JSON.parse(body) }
    await connectionApi(service, executions, 'owner', req, res); return res
  }
  return { service, executions, connection, sent, api, release: () => worker.postMessage({ fixtureRelease: true }) }
}
async function waitFor(check) {
  const until = Date.now() + 5000
  while (!check()) { assert.ok(Date.now() < until, 'fixture wait timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
}

test('standard text waits for asynchronous preparation and authorization before transport', async () => {
  const events = [], abort = new AbortController()
  const execution = { async prepareText() { await Promise.resolve(); events.push('prepare'); return { action: 'read', recordPolicy: 'none', queue: 'ai' } },
    async authorize(_prepared, actor) { await Promise.resolve(); assert.equal(actor, 'user'); events.push('authorize') } }
  const prepared = await prepareTextOperation(execution, 'read', {})
  await authorizeTextOperation(execution, prepared, 'user', { live: true, generation: 'g' })
  const result = await dispatchTextOperation(prepared, { policy: 'none', signal: abort.signal }, async value => { events.push('send'); assert.equal(value.queue, 'ai'); return { rows: [] } })
  assert.deepEqual(events, ['prepare', 'authorize', 'send']); assert.deepEqual(result, { rows: [] })
})

test('text transport requires an external lifecycle for recorded work and does not create one', async () => {
  const prepared = { action: 'read', recordPolicy: 'external' }, abort = new AbortController()
  let calls = 0
  const dispatch = async (_value, scope) => { calls++; scope.onDispatched(); return { ok: true } }
  await assert.rejects(dispatchTextOperation(prepared, { policy: 'none' }, dispatch), /生命周期/)
  await assert.rejects(dispatchTextOperation(prepared, { policy: 'external' }, dispatch), /生命周期/)
  let markers = 0
  assert.deepEqual(await dispatchTextOperation(prepared, { policy: 'external', signal: abort.signal, onDispatched() { markers++ } }, dispatch), { ok: true })
  assert.equal(calls, 1); assert.equal(markers, 1)
})

test('cancel during async preparation or authorization prevents subsequent transport', async () => {
  for (const phase of ['prepare', 'authorize']) {
    const abort = new AbortController()
    const execution = { async prepareText() { if (phase === 'prepare') abort.abort(); return { recordPolicy: 'none' } },
      async authorize() { abort.abort() } }
    const work = async () => { const prepared = await prepareTextOperation(execution, '', {}, undefined, abort.signal);
      await authorizeTextOperation(execution, prepared, 'user', { live: true, generation: 'g' }, undefined, abort.signal) }
    await assert.rejects(work(), /取消/)
  }
})

for (const dialect of ['mysql', 'oracle']) test(`${dialect} module preserves each entry, context defaults and delegated batch authorization`, async () => {
  const execution = createSqlTextExecution(dialect), binding = { dialect, database: 'original-default', environment: 'pvt' }
  assert.deepEqual(execution.normalizeContext(undefined, binding), { schema: 'original-default' })
  assert.deepEqual(execution.normalizeContext({ schema: '' }, binding), { schema: '' })
  for (const context of [{ database: 'x' }, { schema: 2 }, [], null]) assert.throws(() => execution.normalizeContext(context, binding), /目标/)
  for (const entry of ['default', 'query', 'manual-query', 'explain']) {
    const prepared = await prepareTextOperation(execution, 'SELECT id FROM records', { schema: 'app' }, { sourceKind: 'sql', entry })
    await authorizeTextOperation(execution, prepared, entry === 'explain' ? 'ai' : 'user', binding, { sourceKind: 'sql', entry })
    assert.equal(prepared.authorized.kind, 'select')
    assert.equal(prepared.queue, entry === 'explain' ? 'ai' : 'manual')
    assert.equal(prepared.recordPolicy, entry === 'explain' ? 'external' : 'none')
  }
  assert.throws(() => execution.prepareText('SELECT 1', {}, { sourceKind: 'sql', entry: 'forged' }), /入口/)
  const prepared = execution.prepareText('SELECT 1', {}, { sourceKind: 'sql', entry: 'manual-query' })
  await assert.rejects(execution.authorize(prepared, 'ai', binding, { sourceKind: 'sql', entry: 'manual-query' }), /人工/)
  await assert.rejects(execution.authorize(prepared, 'user', binding, { sourceKind: 'sql', entry: 'query' }), /授权/)
})

for (const dialect of ['mysql', 'oracle']) for (const environment of ['sit', 'uat', 'pvt']) test(`${dialect} shared module retains real SQL parser and ${environment} write boundary`, async () => {
  const execution = createSqlTextExecution(dialect), options = { sourceKind: 'sql', entry: 'shared-query' }, binding = { dialect, environment }
  const prepared = execution.prepareText('UPDATE records SET id=2', { schema: 'app' }, options)
  if (environment === 'sit') {
    await execution.authorize(prepared, 'ai', binding, options)
    assert.equal(prepared.authorized.kind, 'write'); assert.deepEqual(prepared.authorized.targets, [{ schema: 'app', name: dialect === 'oracle' ? 'RECORDS' : 'records' }])
  } else await assert.rejects(execution.authorize(prepared, 'ai', binding, options), /只读/)
  assert.equal(prepared.authorized.kind, 'write'); assert.equal(prepared.recordPolicy, 'external')
  await assert.rejects(execution.authorize(execution.prepareText('DROP TABLE records', { schema: 'app' }, options), 'user', binding, options))
})

for (const dialect of ['mysql', 'oracle']) test(`${dialect} actual authenticated old/new queries preserve payloads and zero records`, async t => {
  const f = await serviceFixture(t, dialect), target = { id: f.connection.id, generation: f.connection.generation }
  for (const action of ['query', 'manual-query']) {
    const input = { sql: 'SELECT 1', schema: 'app', limit: 7, params: ['bound'], lane: 'manual', authorized: { kind: 'write' }, recordPolicy: 'owned' }
    const response = await f.api({ action, ...target, input })
    assert.equal(response.status, 200); assert.equal(response.body.executionStatus, undefined); assert.equal(response.body.executionId, undefined)
    const sent = f.sent().at(-1); assert.equal(sent.action, action); assert.deepEqual(sent.input, { ...input, conversationId: 'owner' }); assert.equal(sent.authorized.kind, 'select')
  }
  const response = await f.api({ action: 'source-execute', ...target, initiator: 'ai', input: { text: 'SELECT 2', context: { schema: 'app' }, entry: 'shared-query', recordPolicy: 'owned' } })
  assert.equal(response.status, 200); assert.deepEqual(response.body.rows, [['1']])
  assert.equal(response.body.executionId, undefined); assert.equal(response.body.executionStatus, undefined)
  assert.equal(f.sent().at(-1).action, 'manual-query'); assert.equal(f.sent().at(-1).authorized.kind, 'select')
  assert.equal(f.sent().at(-1).input.schema, 'app')
  assert.equal((await f.api({ action: 'source-execute', ...target, input: { text: 'SELECT 1', context: { database: 'forged' } } })).status, 400)
  assert.equal(f.executions.list('owner').length, 0)
})

test('ordinary SQL and source-execute share human capacity without a second queue', async t => {
  const f = await serviceFixture(t)
  const blocked = [1, 2].map(i => f.service.request('owner', f.connection.id, f.connection.generation, 'query', { sql: `SELECT ${i} /* FIXTURE_BLOCK */`, schema: 'app' }).catch(error => error))
  await waitFor(() => f.sent().length === 2)
  assert.ok((await f.service.request('owner', f.connection.id, f.connection.generation, 'query', { sql: 'SELECT 3', schema: 'app' })).rows)
  const manual = await f.service.executeText('owner', f.connection.id, f.connection.generation, 'SELECT 4', undefined, 'user', undefined, undefined, undefined, { schema: 'app' })
  assert.deepEqual(manual.rows, [['1']]); assert.equal(f.sent().length, 4)
  assert.equal(f.executions.list('owner').length, 0)
  f.release(); await Promise.all(blocked)
})

for (const dialect of ['mysql', 'oracle']) test(`${dialect} real SQL executor checks the entire batch before any database execution`, async () => {
  let executed = 0, released = 0
  const db = dialect === 'mysql' ? {
    stream: new EventEmitter(), query() { executed++; const query = new EventEmitter(); queueMicrotask(() => {
      query.emit('fields', [{ name: 'id' }]); query.emit('result', [1]); query.emit('end')
    }); return query },
  } : { async execute() { executed++; let read = false; return { metaData: [{ name: 'ID' }], resultSet: {
    async getRows() { if (read) return []; read = true; return [[1]] }, async close() {},
  } } } }
  const pool = { async acquire() { return { connection: db, async release() { released++ }, async discard() { throw new Error('unexpected discard') } } } }
  await assert.rejects(executeSql({ sql: 'SELECT id FROM records; DROP TABLE records', schema: 'app' }, { dialect, environment: 'sit' }, undefined, pool))
  assert.equal(executed, 0, 'authorization failure must prevent every batch statement')
  assert.equal(released, 0)
})

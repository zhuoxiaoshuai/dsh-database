import test from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { getEventListeners } from 'node:events'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ConnectionService } from '../src/host/connection-service.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { registerAiTools } from '../src/host/ai-tools.ts'
import { temporaryDirectory, connectionInput } from './helpers.mjs'

async function fixture(t, dialect = 'mysql') {
  const directory = temporaryDirectory(t, 'sql-catalog-'), marker = join(directory, 'dispatch.jsonl')
  const executions = new ExecutionStore(directory)
  const controllers = new Map(), attach = executions.attachAbort.bind(executions), releaseAbort = executions.releaseAbort.bind(executions)
  executions.attachAbort = (id, controller) => { controllers.set(id, controller); attach(id, controller) }
  executions.releaseAbort = (id, controller) => { if (controllers.get(id) === controller) controllers.delete(id); releaseAbort(id, controller) }
  let worker, valid = true
  const service = new ConnectionService(() => valid, directory, undefined, undefined, executions, undefined,
    () => { worker = new Worker(new URL('./fixtures/sql-catalog-worker.mjs', import.meta.url), { workerData: { marker } }); return worker })
  t.after(async () => { await service.dispose(); await executions.dispose() })
  const connection = await service.open('owner', connectionInput({ dialect }), false)
  const tools = new Map(), events = []
  const emit = executions.emitWorkbench.bind(executions)
  executions.emitWorkbench = (owner, event) => { events.push(event); emit(owner, event) }
  registerAiTools({ tools: { register: tool => tools.set(tool.name, tool) } }, service, executions, owner => valid && owner === 'owner')
  const dispatched = () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  const run = async (args = {}, signal) => JSON.parse(await tools.get('database_catalog').execute(JSON.parse(JSON.stringify({ connectionId: connection.id, generation: connection.generation,
    kind: 'tables', schema: 'app', ...args })), { agent: { session: { id: 'owner' } }, signal, callId: 'catalog-call', rootCallId: 'catalog-root' }))
  return { service, executions, connection, run, tools, events, dispatched, controllers, worker: () => worker,
    release: () => worker.postMessage({ fixtureRelease: true }), invalidate: () => { valid = false } }
}
async function waitFor(check) {
  const until = Date.now() + 5000
  while (!check()) { assert.ok(Date.now() < until, 'catalog fixture timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
}
const dispatchCount = record => record.events.filter(event => event.kind === 'dispatched').length

for (const dialect of ['mysql', 'oracle']) test(`${dialect} actual catalog tool keeps shapes, drafts, one record and cache dispatch semantics`, async t => {
  const f = await fixture(t, dialect)
  const before = f.service.getSharedQuery('owner', f.connection.id)
  for (const kind of ['schemas', 'tables', 'table']) {
    const args = { kind, ...(kind === 'schemas' ? { schema: undefined } : {}), ...(kind === 'table' ? { table: 'records' } : {}) }
    const first = await f.run(args), sent = f.dispatched().length
    const second = await f.run(args)
    assert.equal(f.dispatched().length, sent)
    const { executionId: firstId, ...firstValue } = first, { executionId: secondId, ...secondValue } = second
    assert.notEqual(firstId, secondId); assert.deepEqual(firstValue, secondValue); assert.equal(first.executionStatus, undefined)
    const a = f.executions.get('owner', firstId), b = f.executions.get('owner', secondId)
    for (const record of [a, b]) {
      assert.equal(record.type, 'catalog'); assert.equal(record.operation, 'database_catalog'); assert.equal(record.status, 'succeeded')
      assert.equal(record.callId, 'catalog-call'); assert.equal(record.rootCallId, 'catalog-root'); assert.equal(record.historyVisible, false)
      assert.match(record.draft.sql, /SELECT \*/); assert.ok(record.sql); assert.ok(record.conclusion)
    }
    assert.equal(dispatchCount(a), 1); assert.equal(dispatchCount(b), 0)
    if (kind === 'table') { assert.equal(first.indexes.status, 'unavailable'); assert.match(first.indexes.reason, /无权/); assert.equal(first.columns.length, 1) }
  }
  assert.equal(f.executions.list('owner').length, 6)
  assert.equal(f.dispatched().length, dialect === 'mysql' ? 4 : 3)
  assert.deepEqual(f.service.getSharedQuery('owner', f.connection.id), before)
  assert.equal(f.events.filter(e => e.type === 'EXECUTION_FINISHED').length, 0)
  assert.equal(f.controllers.size, 0)
})

test('MySQL cached table and cold indexes are one operation with one actual dispatch', async t => {
  const f = await fixture(t)
  await f.service.catalog('owner', f.connection.id, f.connection.generation, { kind: 'table', schema: 'app', table: 'records' })
  assert.equal(f.executions.list('owner').length, 0)
  const result = await f.run({ kind: 'table', table: 'records' })
  assert.equal(f.dispatched().length, 2)
  assert.equal(f.dispatched()[1].input.kind, 'indexes')
  assert.equal(dispatchCount(f.executions.get('owner', result.executionId)), 1)
})

for (const change of ['cancel', 'generation', 'owner']) test(`queued catalog ${change} never sends the target or marks it dispatched`, async t => {
  const f = await fixture(t)
  const occupied = f.service.catalog('owner', f.connection.id, f.connection.generation, { kind: 'tables', schema: 'app', search: 'BLOCK' }).catch(error => error)
  await waitFor(() => f.dispatched().length === 1)
  const abort = new AbortController(), pending = f.run({ search: 'queued' }, abort.signal)
  const rejection = assert.rejects(pending)
  await waitFor(() => f.executions.list('owner').length === 1)
  assert.equal(dispatchCount(f.executions.list('owner')[0]), 0)
  if (change === 'cancel') abort.abort()
  if (change === 'owner') { f.invalidate(); await f.service.releaseOwner('owner') }
  if (change === 'generation') { await f.worker().terminate(); await f.service.open('owner', connectionInput(), false, f.connection.id) }
  f.release(); await occupied; await rejection
  assert.equal(f.dispatched().filter(r => r.input.search === 'queued').length, 0)
  const record = f.executions.list('owner')[0]
  assert.equal(dispatchCount(record), 0); assert.ok(['cancelled', 'failed', 'unknown'].includes(record.status))
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
  assert.equal(f.executions.list('owner').length, 1)
  assert.equal(f.controllers.size, 0)
})

test('catalog keeps captured target and remains usable after human control or editor changes', async t => {
  const f = await fixture(t)
  const occupied = f.service.catalog('owner', f.connection.id, f.connection.generation, { kind: 'tables', schema: 'app', search: 'BLOCK' })
  await waitFor(() => f.dispatched().length === 1)
  const pending = f.run({ search: 'queued' })
  f.service.takeSharedQuery('owner', f.connection.id, undefined, f.service.getExecutionDocument('owner', f.connection.id).revision)
  f.service.updateSharedQuery('owner', f.connection.id, { sql: 'SELECT 2', schema: 'other' }, 'user', f.service.getExecutionDocument('owner', f.connection.id).revision)
  f.release(); await occupied
  const result = await pending
  assert.equal(f.executions.get('owner', result.executionId).status, 'succeeded')
  assert.equal(f.dispatched().find(r => r.input.search === 'queued').input.schema, 'app')
  assert.equal(f.service.getSharedQuery('owner', f.connection.id).controller, 'user')
})

test('cancellation between MySQL table and indexes prevents the second request', async t => {
  const f = await fixture(t), abort = new AbortController()
  const original = f.service.catalog.bind(f.service)
  f.service.catalog = async (...args) => { const result = await original(...args); if (args[3].kind === 'table') abort.abort(); return result }
  await assert.rejects(f.run({ kind: 'table', table: 'records' }, abort.signal), /未知/)
  assert.equal(f.dispatched().length, 1)
  const record = f.executions.list('owner')[0]
  assert.equal(record.status, 'unknown'); assert.equal(dispatchCount(record), 1)
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
})

for (const search of ['ERROR', 'TIMEOUT', 'EXIT', 'ACL']) test(`catalog ${search} retains error semantics and releases external cancellation`, async t => {
  const f = await fixture(t), abort = new AbortController()
  if (search === 'ACL') {
    const result = await f.run({ search }, abort.signal)
    assert.equal(result.unavailable, true); assert.match(result.reason, /无权/)
  } else await assert.rejects(f.run({ search }, abort.signal))
  const record = f.executions.list('owner')[0]
  assert.ok(['failed', 'unknown'].includes(record.status)); assert.equal(dispatchCount(record), 1)
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
  assert.equal(f.executions.list('owner').length, 1)
  assert.equal(f.controllers.size, 0)
})

test('catalog postMessage failure has no dispatch and the next request works', async t => {
  const f = await fixture(t), worker = f.worker(), original = worker.postMessage.bind(worker)
  worker.postMessage = message => { if (message.action === 'catalog') throw new Error('fixture send failed'); original(message) }
  await assert.rejects(f.run(), /send failed/)
  assert.equal(dispatchCount(f.executions.list('owner')[0]), 0)
  worker.postMessage = original
  assert.ok((await f.run()).executionId)
})

test('dispatched catalog cancellation does not close the shared connection and removes forwarding', async t => {
  const f = await fixture(t), abort = new AbortController()
  const pending = f.run({ search: 'BLOCK' }, abort.signal), rejection = assert.rejects(pending, /未知/)
  await waitFor(() => f.dispatched().length === 1)
  abort.abort(); await rejection
  const record = f.executions.list('owner')[0]
  assert.equal(record.status, 'unknown'); assert.equal(dispatchCount(record), 1)
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
  assert.equal(f.controllers.size, 0)
  assert.ok((await f.run()).items.length)
  assert.equal(f.service.list('owner')[0].live, true)
})

test('late catalog completion preserves an existing terminal record and releases its controller', async t => {
  const f = await fixture(t)
  const pending = f.run({ search: 'BLOCK' })
  await waitFor(() => f.dispatched().length === 1)
  const record = f.executions.list('owner')[0]
  f.executions.complete(record.executionId, 'unknown', 'fixture already ended')
  f.release(); await pending
  assert.equal(f.executions.get('owner', record.executionId).status, 'unknown')
  assert.equal(f.executions.get('owner', record.executionId).message, 'fixture already ended')
  assert.equal(dispatchCount(f.executions.get('owner', record.executionId)), 1)
  assert.equal(f.controllers.size, 0)
})

test('invalid tool kind and missing table are rejected before a catalog record', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run({ kind: 'indexes' }), /kind/)
  await assert.rejects(f.run({ kind: 'table', table: undefined }), /table/)
  assert.equal(f.executions.list('owner').length, 0); assert.equal(f.dispatched().length, 0)
})

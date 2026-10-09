import test from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ConnectionService } from '../src/host/connection-service.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { registerAiTools } from '../src/host/ai-tools.ts'
import { connectionApi } from '../src/host/connection-api.ts'
import { Readable } from 'node:stream'
import { hostModules } from '../src/host/data-sources/modules.ts'
import { temporaryDirectory, connectionInput } from './helpers.mjs'

async function fixture(t, dialect = 'mysql', environment = 'sit') {
  const directory = temporaryDirectory(t, 'sql-operation-')
  const marker = join(directory, 'dispatch.jsonl')
  const executions = new ExecutionStore(directory)
  let worker
  const service = new ConnectionService(() => true, directory, undefined, undefined, executions, undefined,
    () => { worker = new Worker(new URL('./fixtures/sql-operation-worker.mjs', import.meta.url), { workerData: { marker } }); return worker })
  t.after(async () => { await service.dispose(); await executions.dispose() })
  const connection = await service.open('owner', connectionInput({ dialect, environment }), false)
  const events = [], emit = executions.emitWorkbench.bind(executions)
  executions.emitWorkbench = (owner, event) => { events.push(event); emit(owner, event) }
  const dispatched = () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  return { service, executions, connection, events, dispatched, worker: () => worker,
    release: () => { try { worker.postMessage({ fixtureRelease: true }) } catch { /* old worker */ } } }
}
async function waitFor(check) {
  const until = Date.now() + 5000
  while (!check()) { assert.ok(Date.now() < until, 'fixture wait timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
}

for (const dialect of ['mysql', 'oracle']) test(`${dialect} browser spoofing is rejected before actual Worker dispatch or record creation`, async t => {
  const f = await fixture(t, dialect)
  const api = async body => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'POST'; req.headers = { 'content-type': 'application/json' }
    const response = { destroyed: false, writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
    await connectionApi(f.service, f.executions, 'owner', req, response)
    return response
  }
  const before = f.service.getSharedQuery('owner', f.connection.id)
  for (const initiator of ['ai', 'system', null]) {
    assert.equal((await api({ action: 'shared-query-run', id: f.connection.id, generation: f.connection.generation, schema: 'app', sql: 'SELECT 1', initiator })).status, 400)
  }
  for (const source of ['ai', 'system']) {
    assert.equal((await api({ action: 'shared-query-update', id: f.connection.id, source, patch: { sql: 'SELECT forged' } })).status, 400)
  }
  assert.equal((await api({ action: 'shared-query-update', id: f.connection.id, patch: { sql: 'SELECT forged', controller: 'ai' } })).status, 400)
  assert.deepEqual(f.service.getSharedQuery('owner', f.connection.id), before)
  assert.equal(f.executions.list('owner').length, 0)
  assert.equal(f.dispatched().length, 0)
})

test('trusted system document updates remain available behind the browser boundary, including offline editing', async t => {
  const f = await fixture(t)
  const updated = f.service.updateSharedQuery('owner', f.connection.id, { sql: 'SELECT 1', schema: 'app' }, 'system', f.service.getExecutionDocument('owner', f.connection.id).revision)
  assert.equal(updated.controller, 'ai')
  assert.equal(updated.sql, 'SELECT 1')
  const lastRun = { executionId: 'trusted-result', sql: 'SELECT 1', schema: 'app' }
  const next = f.service.updateSharedQuery('owner', f.connection.id, { lastExecutionId: 'trusted-result', lastRun }, 'system', f.service.getExecutionDocument('owner', f.connection.id).revision)
  assert.equal(next.lastExecutionId, undefined, 'result ownership must be derived from actual execution records')
  assert.throws(() => f.service.updateSharedQueryFromBrowser('owner', f.connection.id, { source: 'system', patch: { sql: 'SELECT 2' } }))
  assert.throws(() => f.service.updateSharedQueryFromBrowser('owner', f.connection.id, { patch: { sql: 'SELECT 2', lastExecutionId: 'forged' } }))
  assert.equal(f.service.getSharedQuery('owner', f.connection.id).sql, 'SELECT 1')
  await f.service.disconnect('owner', f.connection.id)
  assert.equal(f.service.updateSharedQueryFromBrowser('owner', f.connection.id, { patch: { sql: 'SELECT 3' }, revision: next.revision }).sql, 'SELECT 3')
  assert.equal(f.executions.list('owner').length, 0)
})
async function occupy(f) {
  const pending = f.service.request('owner', f.connection.id, f.connection.generation, 'maintenance', { kind: 'capability', schema: 'app' }).catch(error => error)
  await waitFor(() => f.dispatched().some(item => item.action === 'maintenance'))
  return { pending }
}

test('request lifecycle hooks run after the existing queue and only after a successful send', async t => {
  const f = await fixture(t)
  const lock = await occupy(f)
  let checked = 0, sent = 0
  const pending = f.service.request('owner', f.connection.id, f.connection.generation, 'query', { sql: 'SELECT 1', schema: 'app' }, undefined, undefined,
    { beforeDispatch: () => checked++, onDispatched: () => sent++ })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(checked, 0); assert.equal(sent, 0)
  f.release(); await lock.pending; await pending
  assert.equal(checked, 1); assert.equal(sent, 1)
  await assert.rejects(f.service.request('owner', f.connection.id, f.connection.generation, 'query', { sql: 'SELECT 1', schema: 'app' }, undefined, undefined,
    { beforeDispatch: () => { throw new Error('target changed') }, onDispatched: () => sent++ }), /target changed/)
  assert.equal(sent, 1)
})

function run(f, kind = 'shared', { sql = 'SELECT id FROM records', initiator = 'ai', signal, revision } = {}) {
  return kind === 'shared' ? f.service.runSharedQuery('owner', { connectionId: f.connection.id, generation: f.connection.generation,
    schema: 'app', sql, revision: revision ?? f.service.getSharedQuery('owner', f.connection.id).revision,
    initiator, callId: 'sql-call', rootCallId: 'sql-root', purpose: 'result' }, signal)
    : f.service.explainPlan('owner', f.connection.id, f.connection.generation,
      { schema: 'app', sql: f.connection.dialect === 'oracle' ? 'EXPLAIN PLAN FOR SELECT id FROM records' : 'EXPLAIN SELECT id FROM records', initiator, callId: 'sql-call', rootCallId: 'sql-root' }, signal)
}

for (const kind of ['shared', 'explain']) test(`${kind} record creation failure releases its SQL run lock without a phantom event`, async t => {
  const f = await fixture(t)
  const create = f.executions.create.bind(f.executions)
  f.executions.create = () => { throw new Error('fixture record failure') }
  await assert.rejects(run(f, kind), /record failure/)
  assert.equal(f.events.some(e => ['EXECUTION_STARTED', 'EXECUTION_FAILED', 'EXECUTION_FINISHED'].includes(e.type)), false)
  f.executions.create = create
  await run(f, kind)
  assert.equal(f.executions.list('owner').length, 1)
})

for (const kind of ['shared', 'explain']) for (const change of ['takeover', 'text', 'schema', 'generation', 'cancel'])
test(`queued SQL ${kind} rejects ${change} without dispatch and retains its single record`, async t => {
  const f = await fixture(t)
  const lock = await occupy(f)
  const abort = new AbortController()
  const pending = run(f, kind, { signal: abort.signal })
  const rejected = assert.rejects(pending)
  await waitFor(() => f.executions.list('owner').length === 1)
  if (kind === 'shared') await waitFor(() => f.executions.list('owner')[0].events.some(e => e.kind === 'check-passed'))
  assert.equal(f.executions.list('owner')[0].events.some(e => e.kind === 'dispatched'), false)
  if (change === 'takeover') f.service.takeSharedQuery('owner', f.connection.id, undefined, f.service.getExecutionDocument('owner', f.connection.id).revision)
  if (change === 'text') f.service.updateSharedQuery('owner', f.connection.id, { sql: 'SELECT 2' }, 'ai', f.service.getExecutionDocument('owner', f.connection.id).revision)
  if (change === 'schema') f.service.updateSharedQuery('owner', f.connection.id, { schema: 'other' }, 'ai', f.service.getExecutionDocument('owner', f.connection.id).revision)
  if (change === 'generation') {
    await f.worker().terminate()
    await f.service.open('owner', connectionInput(), false, f.connection.id)
  }
  if (change === 'cancel') abort.abort()
  f.release(); await lock.pending; await rejected
  const record = f.executions.list('owner')[0]
  assert.equal(f.executions.list('owner').length, 1)
  assert.ok(['failed', 'cancelled', 'unknown'].includes(record.status))
  assert.equal(record.events.some(e => e.kind === 'dispatched'), false)
  assert.equal(f.dispatched().filter(item => item.action === 'query').length, 0)
  assert.equal(record.callId, 'sql-call'); assert.equal(record.rootCallId, 'sql-root')
  const finished = f.events.filter(e => e.type === 'EXECUTION_FAILED')
  const invalidated = change !== 'cancel'
  assert.equal(finished.length, invalidated ? 0 : 1)
  if (!invalidated) assert.equal(finished[0].status, record.status)
})

for (const dialect of ['mysql', 'oracle']) test(`${dialect} shared/explain keep fields, preview, visibility, selection and one event`, async t => {
  const f = await fixture(t, dialect)
  f.service.updateSharedQuery('owner', f.connection.id, { sql: 'SELECT id FROM records; SELECT 2', schema: 'app' }, 'user', f.service.getExecutionDocument('owner', f.connection.id).revision)
  const query = f.service.getSharedQuery('owner', f.connection.id)
  const selected = await run(f, 'shared', { initiator: 'user', sql: 'SELECT id FROM records', revision: query.revision })
  assert.equal(selected.status, 'succeeded'); assert.equal(selected.result.rows[0][0], '1')
  assert.ok(selected.model.rows); assert.equal(selected.executionStatus, undefined)
  const plan = await run(f, 'explain', { initiator: 'user' })
  assert.deepEqual(plan.columns, ['id']); assert.equal(plan.executionStatus, undefined)
  const records = f.executions.list('owner')
  assert.equal(records.length, 2)
  assert.ok(records.every(r => r.status === 'succeeded' && r.historyVisible === false && r.schema === 'app'
    && r.callId === 'sql-call' && r.rootCallId === 'sql-root' && r.events.filter(e => e.kind === 'dispatched').length === 1))
  assert.deepEqual(f.executions.get('owner', selected.executionId, true).result.rows, [['1']])
  assert.equal(records.find(r => r.executionId === plan.executionId).type, 'explain')
  assert.equal(f.events.filter(e => e.type === 'EXECUTION_FINISHED').length, 2)
  assert.equal(f.service.getSharedQuery('owner', f.connection.id).sql, query.sql, 'selection execution must retain the complete document')
  await assert.rejects(run(f, 'shared', { initiator: 'user', revision: query.revision - 1 }), /已变化/)
})

for (const kind of ['shared', 'explain']) test(`${kind} postMessage failure is not dispatched and releases the run lock`, async t => {
  const f = await fixture(t)
  const worker = f.worker(), send = worker.postMessage.bind(worker)
  worker.postMessage = message => { if (message.action === 'query') throw new Error('fixture send failed'); return send(message) }
  await assert.rejects(run(f, kind), /send failed/)
  const record = f.executions.list('owner')[0]
  assert.equal(record.status, 'failed'); assert.equal(record.events.some(e => e.kind === 'dispatched'), false)
  worker.postMessage = send
  await run(f, kind)
  assert.equal(f.executions.list('owner').filter(r => r.status === 'succeeded').length, 1)
})

for (const kind of ['shared', 'explain']) test(`${kind} history cancellation preserves its terminal status in the emitted event`, async t => {
  const f = await fixture(t)
  const originalSend = f.worker().postMessage.bind(f.worker())
  if (kind === 'explain') {
    f.worker().postMessage = message => originalSend(message.action === 'query'
      ? { ...message, input: { ...message.input, sql: message.input.sql + ' /* FIXTURE_BLOCK */' } } : message)
  }
  const pending = run(f, kind, { sql: 'SELECT id FROM records /* FIXTURE_BLOCK */' })
  const rejected = assert.rejects(pending)
  await waitFor(() => f.dispatched().some(item => item.action === 'query'))
  const record = f.executions.list('owner')[0]
  assert.equal(record.events.filter(e => e.kind === 'dispatched').length, 1)
  f.executions.cancel('owner', record.executionId, true)
  f.release(); await rejected
  const ended = f.executions.get('owner', record.executionId)
  assert.equal(ended.status, 'unknown')
  assert.equal(f.events.find(e => e.type === 'EXECUTION_FAILED').status, ended.status)
  assert.equal(f.executions.list('owner').length, 1)
  f.worker().postMessage = originalSend
  await run(f, kind)
})

for (const dialect of ['mysql', 'oracle']) for (const environment of ['sit', 'uat', 'pvt']) test(`${dialect} SQL shared ${environment} retains its write policy and ordinary manual path`, async t => {
  const f = await fixture(t, dialect, environment)
  if (environment === 'sit') assert.equal((await run(f, 'shared', { sql: 'UPDATE records SET id = 2' })).status, 'succeeded')
  else {
    await assert.rejects(run(f, 'shared', { sql: 'UPDATE records SET id = 2' }), /只读/)
    assert.equal(f.dispatched().filter(item => item.action === 'query').length, 0)
    assert.equal(f.executions.list('owner')[0].status, 'failed')
  }
  const count = f.executions.list('owner').length
  await f.service.request('owner', f.connection.id, f.connection.generation, 'manual-query', { schema: 'app', sql: 'UPDATE records SET id = 2' })
  assert.equal(f.executions.list('owner').length, count)
})

for (const change of ['takeover', 'text', 'schema', 'generation', 'cancel']) test(`SQL module async authorization rejects ${change} before dispatch with one record`, async t => {
  const f = await fixture(t), execution = hostModules.get('mysql').execution, original = execution.authorize
  let release, entered = false
  const gate = new Promise(resolve => { release = resolve })
  execution.authorize = async (...args) => { entered = true; await gate; return original(...args) }
  t.after(() => { execution.authorize = original; release() })
  const abort = new AbortController(), pending = run(f, 'shared', { signal: abort.signal })
  const rejected = assert.rejects(pending)
  await waitFor(() => entered)
  assert.equal(f.executions.list('owner').length, 1)
  if (change === 'takeover') f.service.takeSharedQuery('owner', f.connection.id, undefined, f.service.getExecutionDocument('owner', f.connection.id).revision)
  if (change === 'text') f.service.updateSharedQuery('owner', f.connection.id, { sql: 'SELECT 2' }, 'ai', f.service.getExecutionDocument('owner', f.connection.id).revision)
  if (change === 'schema') f.service.updateSharedQuery('owner', f.connection.id, { schema: 'other' }, 'ai', f.service.getExecutionDocument('owner', f.connection.id).revision)
  if (change === 'generation') await f.worker().terminate()
  if (change === 'cancel') abort.abort()
  release(); await rejected
  assert.equal(f.dispatched().filter(item => item.action === 'query').length, 0)
  assert.equal(f.executions.list('owner').length, 1)
  assert.equal(f.executions.list('owner')[0].events.some(event => event.kind === 'dispatched'), false)
})

for (const selector of ['FIXTURE_ERROR', 'FIXTURE_TIMEOUT', 'FIXTURE_EXIT']) test(`SQL ${selector} ends once and cleans external abort forwarding`, async t => {
  const f = await fixture(t)
  const external = new AbortController()
  let added = 0, removed = 0
  const add = external.signal.addEventListener.bind(external.signal), remove = external.signal.removeEventListener.bind(external.signal)
  external.signal.addEventListener = (...args) => { added++; return add(...args) }
  external.signal.removeEventListener = (...args) => { removed++; return remove(...args) }
  await assert.rejects(run(f, 'shared', { sql: `SELECT id FROM records /* ${selector} */`, signal: external.signal }))
  assert.equal(added, removed)
  const record = f.executions.list('owner')[0]
  assert.equal(f.executions.list('owner').length, 1)
  assert.equal(record.events.filter(e => e.kind === 'dispatched').length, 1)
  const failure = f.events.find(e => e.type === 'EXECUTION_FAILED')
  if (selector === 'FIXTURE_EXIT') assert.equal(failure, undefined, 'retired generations cannot publish a current result')
  else assert.equal(failure.status, record.status)
})

test('late successful SQL receipt cannot replace an unknown record or publish a successful grid', async t => {
  const f = await fixture(t)
  const pending = run(f, 'shared', { sql: 'SELECT id FROM records /* FIXTURE_BLOCK */' })
  const rejected = assert.rejects(pending, /earlier unknown/)
  await waitFor(() => f.dispatched().some(item => item.action === 'query'))
  const record = f.executions.list('owner')[0]
  f.executions.complete(record.executionId, 'unknown', 'earlier unknown')
  f.release(); await rejected
  const ended = f.executions.get('owner', record.executionId, true)
  assert.equal(ended.status, 'unknown'); assert.equal(ended.result, undefined)
  assert.equal(f.events.some(e => e.type === 'EXECUTION_FINISHED'), false)
  assert.equal(f.events.find(e => e.type === 'EXECUTION_FAILED').status, 'unknown')
  const lastRun = f.service.getSharedQuery('owner', f.connection.id).lastRun
  assert.deepEqual(lastRun.columns, []); assert.equal(lastRun.rowCount, 0); assert.equal(lastRun.message, 'earlier unknown')
})

test('a dispatched result can finish its record without updating a later SQL draft', async t => {
  const f = await fixture(t)
  const pending = run(f, 'shared', { sql: 'SELECT id FROM records /* FIXTURE_BLOCK */' })
  await waitFor(() => f.dispatched().some(item => item.action === 'query'))
  f.service.updateSharedQuery('owner', f.connection.id, { sql: 'SELECT 99', schema: 'other' }, 'user', f.service.getExecutionDocument('owner', f.connection.id).revision)
  f.release()
  const outcome = await pending
  assert.equal(outcome.controlLost, true); assert.equal(outcome.status, 'succeeded')
  const query = f.service.getSharedQuery('owner', f.connection.id)
  assert.equal(query.sql, 'SELECT 99'); assert.equal(query.schema, 'other'); assert.equal(query.lastRun, undefined)
})

for (const change of ['takeover', 'text', 'schema', 'cancel']) test(`actual SQL tool queued ${change} uses one lifecycle and keeps call IDs`, async t => {
  const f = await fixture(t)
  const tools = new Map()
  registerAiTools({ tools: { register(tool) { tools.set(tool.name, tool) } } }, f.service, f.executions, id => id === 'owner')
  const lock = await occupy(f), external = new AbortController()
  const pending = tools.get('database_execute_sql').execute({ connectionId: f.connection.id, generation: f.connection.generation,
    schema: 'app', sql: 'SELECT id FROM records', purpose: 'result' },
    { agent: { session: { id: 'owner' } }, callId: 'real-call', rootCallId: 'real-root', signal: external.signal })
  const rejected = assert.rejects(pending)
  await waitFor(() => f.executions.list('owner').some(r => r.events.some(e => e.kind === 'check-passed')))
  if (change === 'takeover') f.service.takeSharedQuery('owner', f.connection.id, undefined, f.service.getExecutionDocument('owner', f.connection.id).revision)
  if (change === 'text') f.service.updateSharedQuery('owner', f.connection.id, { sql: 'SELECT 99' }, 'ai', f.service.getExecutionDocument('owner', f.connection.id).revision)
  if (change === 'schema') f.service.updateSharedQuery('owner', f.connection.id, { schema: 'other' }, 'ai', f.service.getExecutionDocument('owner', f.connection.id).revision)
  if (change === 'cancel') external.abort()
  f.release(); await lock.pending; await rejected
  const records = f.executions.list('owner')
  assert.equal(records.length, 1); assert.equal(records[0].callId, 'real-call'); assert.equal(records[0].rootCallId, 'real-root')
  assert.equal(records[0].events.some(e => e.kind === 'dispatched'), false)
  assert.equal(f.dispatched().some(item => item.action === 'query'), false)
})

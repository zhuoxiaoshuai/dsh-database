import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runOperation, runLocalOperation } from '../src/host/operation-runtime.ts'
import { getEventListeners } from 'node:events'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { temporaryDirectory } from './helpers.mjs'

const binding = { owner: 'owner', connectionId: 'connection', generation: 'g1', connectionName: 'Redis', sourceId: 'redis', environment: 'sit' }
const metadata = { operation: 'redis_execute', title: 'Redis SET', initiator: 'ai', callId: 'call', rootCallId: 'root', type: 'tool' }
const interruption = (_error, state) => state.dispatched ? 'unknown' : state.aborted ? 'cancelled' : 'failed'

for (const mode of ['success', 'failure', 'cancel', 'store-cancel', 'unknown']) test(`local lifecycle ${mode} has no dispatch and releases every resource`, async t => {
  const store = new ExecutionStore(temporaryDirectory(t, 'local-runtime-'))
  t.after(() => store.dispose())
  const external = new AbortController()
  let releases = 0, completions = 0
  const release = store.releaseAbort.bind(store), complete = store.complete.bind(store)
  store.releaseAbort = (...args) => { releases++; release(...args) }
  store.complete = (...args) => { completions++; complete(...args) }
  const promise = runLocalOperation(store, { owner: 'owner' }, { ...metadata, operation: 'database_templates' }, async (signal, context) => {
    assert.equal(context.markDispatched, undefined)
    context.markChecked(); context.markChecked(); context.markRunning(); context.markRunning()
    context.annotate({ sql: 'SELECT 1', draft: { kind: 'query', sql: 'SELECT 1' }, controller: 'forged' })
    if (mode === 'store-cancel') store.cancel('owner', context.executionId, false)
    if (mode === 'unknown') complete(context.executionId, 'unknown', 'prior outcome')
    if (mode === 'cancel') { external.abort(); assert.equal(signal.aborted, true); throw new Error('cancelled') }
    if (mode === 'failure') throw new Error('failed')
    return { value: { saved: true }, message: 'saved', conclusion: 'saved' }
  }, external.signal)
  if (mode === 'failure' || mode === 'cancel') await assert.rejects(promise)
  else assert.deepEqual(await promise, { saved: true })
  const [record] = store.list('owner')
  assert.equal(store.list('owner').length, 1)
  assert.equal(record.status, ({success: 'succeeded', failure: 'failed', cancel: 'cancelled', 'store-cancel': 'cancelled', unknown: 'unknown'})[mode])
  assert.equal(record.connectionId, undefined); assert.equal(record.generation, undefined); assert.equal(record.dialect, undefined)
  assert.equal(record.type, 'tool'); assert.equal(record.historyVisible, false)
  assert.equal(record.events.filter(e => e.kind === 'dispatched').length, 0)
  assert.equal(record.events.filter(e => e.kind === 'check-passed').length, 1)
  assert.equal(record.controller, undefined); assert.equal(record.sql, 'SELECT 1')
  assert.equal(releases, 1); assert.equal(completions, 1)
  assert.equal(getEventListeners(external.signal, 'abort').length, 0)
})

test('local cancellation before invocation and between record creation and work never performs work', async t => {
  const store = new ExecutionStore(temporaryDirectory(t, 'local-pre-cancel-'))
  t.after(() => store.dispose())
  const external = new AbortController(); external.abort()
  let calls = 0
  const work = async () => { calls++; return { value: true } }
  await assert.rejects(runLocalOperation(store, { owner: 'owner' }, metadata, work, external.signal), /取消/)
  assert.equal(store.list('owner').length, 0)
  const attach = store.attachAbort.bind(store)
  store.attachAbort = (id, controller) => { attach(id, controller); controller.abort() }
  await assert.rejects(runLocalOperation(store, { owner: 'owner' }, metadata, work), /取消/)
  assert.equal(calls, 0); assert.equal(store.list('owner')[0].status, 'cancelled')
})

test('record creation failure releases the external cancellation listener without invoking work', async t => {
  const store = new ExecutionStore(temporaryDirectory(t, 'local-create-failure-'))
  t.after(() => store.dispose())
  const external = new AbortController()
  store.create = () => { throw new Error('storage unavailable') }
  await assert.rejects(runLocalOperation(store, {owner: 'owner'}, metadata, async () => {
    assert.fail('work cannot start without a record')
  }, external.signal), /storage unavailable/)
  assert.equal(getEventListeners(external.signal, 'abort').length, 0)
})

for (const outcome of ['success', 'error', 'cancel']) test(`default read lifecycle ${outcome} releases listeners and keeps safe failure summaries`, async t => {
  const directory = temporaryDirectory(t, 'operation-read-')
  const store = new ExecutionStore(directory)
  t.after(() => store.dispose())
  const external = new AbortController()
  let added = 0, removed = 0, released = 0
  const add = external.signal.addEventListener.bind(external.signal), remove = external.signal.removeEventListener.bind(external.signal)
  external.signal.addEventListener = (...args) => { added++; return add(...args) }
  external.signal.removeEventListener = (...args) => { removed++; return remove(...args) }
  const release = store.releaseAbort.bind(store)
  store.releaseAbort = (...args) => { released++; release(...args) }
  const original = new Error('private-key SECRET_PAYLOAD')
  const promise = runOperation(store, binding, { ...metadata, operation: 'redis_value' }, async (_signal, mark) => {
    if (outcome === 'success') { mark(); mark(); return { keys: [] } }
    if (outcome === 'cancel') { mark(); external.abort() }
    throw original
  }, () => '读取完成。', external.signal, undefined, { summarizeFailure: (_error, state, status) => {
    assert.equal(state.dispatched, outcome === 'cancel')
    return status === 'cancelled' ? '读取已取消。' : '读取失败。'
  } })
  if (outcome === 'success') assert.equal((await promise).executionStatus, 'succeeded')
  else await assert.rejects(promise, error => error === original)
  const [record] = store.list('owner')
  assert.equal(record.status, outcome === 'success' ? 'succeeded' : outcome === 'cancel' ? 'cancelled' : 'failed')
  assert.equal(record.events.filter(e => e.kind === 'dispatched').length, outcome === 'error' ? 0 : 1)
  assert.equal(added, removed); assert.equal(released, 1)
  const saved = readFileSync(join(directory, 'ai-executions.json'), 'utf8')
  assert.ok(!saved.includes('private-key') && !saved.includes('SECRET_PAYLOAD'))
})

for (const dispatched of [false, true]) test(`operation interruption before/after dispatch (${dispatched}) cleans listeners and records once`, async t => {
  const store = new ExecutionStore(temporaryDirectory(t, 'operation-interruption-'))
  t.after(() => store.dispose())
  const external = new AbortController()
  let added = 0, removed = 0, released = 0
  const add = external.signal.addEventListener.bind(external.signal), remove = external.signal.removeEventListener.bind(external.signal)
  external.signal.addEventListener = (...args) => { added++; return add(...args) }
  external.signal.removeEventListener = (...args) => { removed++; return remove(...args) }
  const release = store.releaseAbort.bind(store)
  store.releaseAbort = (...args) => { released++; release(...args) }
  const events = []
  await assert.rejects(runOperation(store, binding, metadata, async (signal, mark) => {
    if (dispatched) { mark(); mark() }
    external.abort()
    assert.equal(signal.aborted, true)
    throw new Error('interrupted')
  }, () => 'done', external.signal, undefined, { classifyInterruption: interruption, onFinished: (...args) => events.push(args) }))
  const records = store.list('owner')
  assert.equal(records.length, 1)
  assert.equal(records[0].status, dispatched ? 'unknown' : 'cancelled')
  assert.equal(records[0].events.filter(event => event.kind === 'dispatched').length, dispatched ? 1 : 0)
  assert.equal(records[0].type, 'tool'); assert.equal(records[0].rootCallId, 'root')
  assert.equal(events.length, 1); assert.equal(events[0][1], records[0].status)
  assert.equal(added, removed); assert.equal(released, 1)
})

for (const terminal of ['unknown', 'cancelled']) test(`late successful result preserves stored ${terminal} in output and event`, async t => {
  const store = new ExecutionStore(temporaryDirectory(t, 'operation-late-'))
  t.after(() => store.dispose())
  const finished = []
  const result = await runOperation(store, binding, metadata, async (_signal, mark) => {
    mark()
    const record = store.list('owner')[0]
    store.complete(record.executionId, terminal, 'earlier outcome')
    return { result: { type: 'string', value: 'OK' } }
  }, () => 'success', undefined, undefined, { completedResultIsDefinitive: true, onFinished: (_id, status) => finished.push(status) })
  assert.equal(result.executionStatus, terminal)
  assert.deepEqual(finished, [terminal])
  assert.equal(store.list('owner')[0].status, terminal)
})

test('definite completion can win an external abort race while pre-dispatch failure remains failed', async t => {
  const store = new ExecutionStore(temporaryDirectory(t, 'operation-race-'))
  t.after(() => store.dispose())
  const abort = new AbortController()
  const result = await runOperation(store, binding, metadata, async (_signal, mark) => { mark(); abort.abort(); return { failed: false } },
    () => 'confirmed', abort.signal, () => 'succeeded', { classifyInterruption: interruption, completedResultIsDefinitive: true })
  assert.equal(result.executionStatus, 'succeeded')
  await assert.rejects(runOperation(store, binding, metadata, async () => { throw new Error('revision changed') }, () => '', undefined, undefined, { classifyInterruption: interruption }))
  assert.equal(store.list('owner').filter(record => record.status === 'failed').length, 1)
})

test('a bounded partial result ends one execution with its provider status and call correlation', async () => {
  const created = [], completed = []
  const executions = {
    create(input) { created.push(input); return { executionId: 'once' } },
    attachAbort() {}, event() {}, transition() {},
    complete(...args) { completed.push(args) },
  }
  const binding = { owner: 'owner', connectionId: 'connection', generation: 'g1', connectionName: 'Kafka', sourceId: 'kafka', environment: 'sit' }
  const result = await runOperation(executions, binding, { operation: 'kafka_peek', title: '读取', initiator: 'ai', callId: 'call', rootCallId: 'root' },
    async () => ({ kind: 'peek', reason: 'deadline', messages: [{ offset: '1' }] }),
    value => `已读取 ${value.messages.length} 条，未完成。`, undefined, value => value.reason === 'deadline' ? 'failed' : 'succeeded')
  assert.equal(created.length, 1)
  assert.equal(created[0].rootCallId, 'root')
  assert.equal(result.executionId, 'once')
  assert.equal(result.executionStatus, 'failed')
  assert.deepEqual(completed, [['once', 'failed', '已读取 1 条，未完成。']])
})
test('SQL completion preserves explicit history metadata and bounded preview with deferred checks', async t => {
  const store = new ExecutionStore(temporaryDirectory(t, 'operation-sql-'))
  t.after(() => store.dispose())
  const sql = 'SELECT id FROM records'
  const result = { columns: ['id'], rows: Array.from({ length: 150 }, (_, i) => [String(i)]), elapsedMs: 2, truncated: false }
  const output = await runOperation(store, { ...binding, sourceId: 'mysql' }, {
    ...metadata, type: 'query', historyVisible: false, schema: 'app', tables: ['records'], sql, executedSql: sql,
    draft: { kind: 'query', sql, schema: 'app' }, reason: 'existing reason', queryRevision: 3,
  }, async (_signal, mark, context) => {
    assert.ok(context.executionId)
    assert.equal(store.list('owner')[0].events.some(e => e.kind === 'check-passed'), false)
    context.markChecked(); context.markChecked(); mark()
    return { result }
  }, () => 'unused', undefined, undefined, { deferCheckPassed: true,
    projectCompletion: value => ({ message: 'complete', result: value.result, conclusion: 'SQL conclusion' }) })
  const record = store.get('owner', output.executionId, true)
  assert.equal(record.historyVisible, false)
  assert.equal(record.schema, 'app'); assert.equal(record.sql, sql); assert.equal(record.executedSql, sql)
  assert.deepEqual(record.tables, ['records']); assert.equal(record.reason, 'existing reason')
  assert.equal(record.queryRevision, 3); assert.equal(record.conclusion, 'SQL conclusion')
  assert.equal(record.resultMeta.rowCount, 150); assert.ok(record.result.rows.length < 150)
  assert.equal(record.events.filter(e => e.kind === 'check-passed').length, 1)
  assert.equal(record.events.filter(e => e.kind === 'dispatched').length, 1)
})

test('deferred authorization rejection retains one record without passed or dispatched events', async t => {
  const store = new ExecutionStore(temporaryDirectory(t, 'operation-sql-rejected-'))
  t.after(() => store.dispose())
  await assert.rejects(runOperation(store, binding, metadata, async () => { throw new Error('denied') }, () => '',
    undefined, undefined, { deferCheckPassed: true }), /denied/)
  const records = store.list('owner')
  assert.equal(records.length, 1); assert.equal(records[0].status, 'failed')
  assert.equal(records[0].events.some(e => ['check-passed', 'dispatched'].includes(e.kind)), false)
})

test('late lifecycle markers cannot reactivate a terminal record or change its failure message', async t => {
  const store = new ExecutionStore(temporaryDirectory(t, 'operation-terminal-mark-'))
  t.after(() => store.dispose())
  let finished
  await assert.rejects(runOperation(store, binding, metadata, async (_signal, mark, context) => {
    store.complete(context.executionId, 'unknown', 'earlier outcome')
    context.markChecked(); mark()
    throw new Error('late error')
  }, () => '', undefined, undefined, { deferCheckPassed: true, onFinished: (...args) => { finished = args } }), /late error/)
  const record = store.list('owner')[0]
  assert.equal(record.status, 'unknown')
  assert.equal(record.events.some(e => ['check-passed', 'dispatched'].includes(e.kind)), false)
  assert.equal(finished[1], 'unknown'); assert.equal(finished[3], 'earlier outcome')
})

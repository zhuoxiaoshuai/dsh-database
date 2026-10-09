import test from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { ConnectionService } from '../src/host/connection-service.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { connectionApi } from '../src/host/connection-api.ts'
import { createSqlTextExecution } from '../src/host/data-sources/sql-execution.ts'
import { authorizeTextOperation } from '../src/host/text-execution.ts'
import { temporaryDirectory, connectionInput } from './helpers.mjs'

async function fixture(t, dialect = 'mysql', receipt) {
  const directory = temporaryDirectory(t, 'host-boundary-'), marker = join(directory, 'sent.jsonl')
  const store = new ExecutionStore(directory)
  let worker
  const service = new ConnectionService(() => true, directory, undefined, undefined, store, undefined, () => {
    worker = new Worker(new URL('./fixtures/sql-operation-worker.mjs', import.meta.url), { workerData: { marker } })
    if (receipt) worker.on('message', message => { if (message.result?.columns) Object.assign(message.result, receipt) })
    return worker
  })
  t.after(async () => { await service.dispose(); await store.dispose() })
  const connection = await service.open('owner', connectionInput({ dialect }), false)
  const sent = () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  const api = async body => {
    const req = Readable.from([Buffer.from(JSON.stringify({ id: connection.id, generation: connection.generation, ...body }))])
    req.method = 'POST'; req.headers = { 'content-type': 'application/json' }
    const res = new EventEmitter(); res.destroyed = false; res.writeHead = status => { res.status = status }
    res.end = body => { res.writableEnded = true; res.body = JSON.parse(body) }
    await connectionApi(service, store, 'owner', req, res)
    return res
  }
  const edit = sql => {
    const document = service.getExecutionDocument('owner', connection.id)
    return service.updateExecutionDocument('owner', connection.id, sql, 'user', document.revision, connection.generation, { schema: 'app' })
  }
  return { directory, service, store, connection, sent, api, edit, release: () => worker.postMessage({ fixtureRelease: true }) }
}

async function waitFor(check) {
  const until = Date.now() + 5000
  while (!check()) { assert.ok(Date.now() < until, 'fixture deadline'); await new Promise(resolve => setTimeout(resolve, 5)) }
}

for (const dialect of ['mysql', 'oracle']) test(`${dialect} AI verification preserves canonical document and does not publish a display result`, async t => {
  const f = await fixture(t, dialect)
  let document = f.edit('SELECT id FROM records')
  document = f.service.controlExecutionDocument('owner', f.connection.id, 'ai', undefined, f.connection.generation, document.revision)
  const receipt = await f.service.runSharedQuery('owner', { connectionId: f.connection.id, generation: f.connection.generation,
    sql: 'SELECT 1', schema: 'app', revision: document.revision, initiator: 'ai' })
  assert.deepEqual(f.service.getExecutionDocument('owner', f.connection.id), document)
  assert.equal(f.store.get('owner', receipt.executionId).type, 'verify')
  assert.equal(f.store.latestDisplay('owner', f.connection.id), undefined)
  const explicit = await f.service.runSharedQuery('owner', { connectionId: f.connection.id, generation: f.connection.generation,
    sql: 'SELECT 1', schema: 'app', revision: document.revision, initiator: 'ai', purpose: 'result' })
  assert.equal(f.service.getExecutionDocument('owner', f.connection.id).text, 'SELECT 1')
  assert.equal(f.store.latestDisplay('owner', f.connection.id).executionId, explicit.executionId)
})

for (const dialect of ['mysql', 'oracle']) test(`${dialect} document core and compatibility execution do not read history projections`, async t => {
  const f = await fixture(t, dialect), document = f.edit('SELECT id FROM records')
  f.service.getSharedQuery = () => { throw new Error('compatibility projection reached core') }
  const response = await f.api({ action: 'execution-document-run', revision: document.revision })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.identity, {
    conversationId: 'owner', connectionId: f.connection.id, sourceId: dialect,
    generation: f.connection.generation, context: { schema: 'app' }, queryRevision: document.revision,
    documentText: document.text, executedSql: response.body.executedSql, initiator: 'user',
  })
  const legacy = await f.api({ action: 'shared-query-run', revision: document.revision, sql: document.text, schema: 'app' })
  assert.equal(legacy.status, 200)
  assert.deepEqual(legacy.body.identity, response.body.identity)
})

for (const action of ['execution-document-run', 'shared-query-run']) test(`${action} rejects missing revisions, old generations and AI-controlled browser execution`, async t => {
  const f = await fixture(t), document = f.edit('SELECT id FROM records')
  for (const change of [{ revision: undefined }, { generation: 'old', revision: document.revision }, { revision: document.revision - 1 }]) {
    assert.notEqual((await f.api({ action, ...change })).status, 200)
  }
  const controlled = f.service.controlExecutionDocument('owner', f.connection.id, 'ai', 'return-ai', f.connection.generation, document.revision)
  assert.notEqual((await f.api({ action, revision: controlled.revision, initiator: 'ai' })).status, 200)
  assert.equal(f.sent().length, 0)
})

test('late SQL receipt retains its original identity after the document changes', async t => {
  const f = await fixture(t), document = f.edit('SELECT id FROM records /* FIXTURE_BLOCK */')
  const finished = [], emit = f.store.emitWorkbench.bind(f.store)
  f.store.emitWorkbench = (owner, event) => { if (event.type === 'EXECUTION_FINISHED') finished.push(event); return emit(owner, event) }
  const running = f.service.runExecutionDocument('owner', f.connection.id, f.connection.generation, document.revision)
  await waitFor(() => f.sent().length === 1)
  f.edit('SELECT id FROM newer_records')
  f.release()
  const result = await running
  assert.equal(result.identity.documentText, document.text)
  assert.equal(result.identity.queryRevision, document.revision)
  assert.equal(finished.length, 0)
  assert.deepEqual(f.store.get('owner', result.executionId).identity, result.identity)
  assert.notEqual(f.service.getExecutionDocument('owner', f.connection.id).text, result.identity.documentText)
})

test('SQL failure HTTP response carries the captured identity and execution record', async t => {
  const f = await fixture(t), document = f.edit('SELECT id FROM records /* FIXTURE_ERROR */')
  const response = await f.api({ action: 'execution-document-run', revision: document.revision })
  assert.notEqual(response.status, 200)
  assert.ok(response.body.executionId)
  assert.equal(response.body.identity.documentText, document.text)
  assert.equal(response.body.identity.queryRevision, document.revision)
  assert.equal(response.body.identity.initiator, 'user')
  assert.equal(response.body.kind, 'query')
})

for (const dialect of ['mysql', 'oracle']) test(`${dialect} direct and failed EXPLAIN receipts keep their authorized display kind`, async t => {
  const f = await fixture(t, dialect)
  const prefix = dialect === 'oracle' ? 'EXPLAIN PLAN FOR ' : 'EXPLAIN '
  for (const suffix of ['', ' /* FIXTURE_ERROR */']) {
    const document = f.edit(prefix + 'SELECT id FROM records' + suffix)
    const response = await f.api({ action: 'execution-document-run', revision: document.revision })
    assert.equal(response.body.kind, 'explain')
    assert.equal(response.body.identity.documentText, document.text)
    assert.equal(response.status === 200, suffix === '')
  }
})

test('SQL authorization returns its analysis explicitly without an afterAnalysis callback', async () => {
  const execution = createSqlTextExecution('mysql'), options = { sourceKind: 'sql', entry: 'shared-query' }
  const prepared = execution.prepareText('UPDATE records SET id=2', { schema: 'app' }, options)
  const analysis = await authorizeTextOperation(execution, prepared, 'user', { dialect: 'mysql', environment: 'pvt' }, options)
  assert.equal(analysis.kind, 'write')
  assert.equal(prepared.sourceKind, 'sql')
  assert.equal(prepared.authorized.sql, analysis.sql)
  assert.equal(Object.hasOwn(prepared, 'analysis'), false)
})

test('SQL recovery retains the captured identity without inventing current toolbar fields', async t => {
  const f = await fixture(t), document = f.edit('SELECT id FROM records')
  const result = await f.service.runExecutionDocument('owner', f.connection.id, f.connection.generation, document.revision)
  const restarted = new ExecutionStore(f.directory)
  t.after(() => restarted.dispose())
  const recovered = restarted.latestDisplay('owner', f.connection.id)
  assert.deepEqual(recovered.identity, result.identity)
  assert.equal(recovered.result.rows[0][0], '1')
})

test('a late trusted SQL reply cannot turn an existing unknown record into a retryable HTTP failure', async t => {
  const steps = [
    { index: 0, sql: 'UPDATE records SET id=2', status: 'succeeded', affectedRows: 1 },
    { index: 1, sql: 'UPDATE records SET id=3 /* FIXTURE_BLOCK */', status: 'unknown', error: '等待核验。' },
  ]
  const batch = [{ columns: [], rows: [], elapsedMs: 1, truncated: false, affectedRows: 1, stepIndex: 0 }]
  const f = await fixture(t, 'mysql', { steps, batch }), document = f.edit(steps.map(step => step.sql).join('; '))
  const pending = f.api({ action: 'execution-document-run', revision: document.revision })
  await waitFor(() => f.sent().length === 1)
  const record = f.store.list('owner')[0]
  assert.ok(record.events.some(event => event.kind === 'dispatched'))
  f.store.complete(record.executionId, 'unknown', '写入回执待核验。')
  f.release()
  const response = await pending
  assert.notEqual(response.status, 200)
  assert.equal(response.body.effect, 'unknown')
  assert.equal(response.body.phase, 'receipt')
  assert.equal(response.body.status, 'unknown')
  assert.equal(response.body.executionId, record.executionId)
  assert.equal(response.body.kind, 'write')
  assert.deepEqual(response.body.steps, steps)
  assert.deepEqual(response.body.batch, batch)
  assert.deepEqual(response.body.identity, f.store.get('owner', record.executionId).identity)
})

for (const sourceId of ['redis', 'kafka']) test(`${sourceId} live identity does not expand persisted business payload`, async t => {
  const directory = temporaryDirectory(t, `host-boundary-${sourceId}-`), store = new ExecutionStore(directory)
  t.after(() => store.dispose())
  const identity = { conversationId: 'owner', connectionId: 'connection', sourceId, generation: 'g',
    context: sourceId === 'redis' ? { database: '0' } : {}, queryRevision: 2,
    documentText: 'PRIVATE_BUSINESS_BODY', executedSql: 'PRIVATE_BUSINESS_BODY', initiator: 'user' }
  const record = store.create({ conversationId: 'owner', connectionId: 'connection', generation: 'g', dialect: sourceId,
    operation: `${sourceId}_execute`, documentText: identity.documentText, executedSql: identity.executedSql, identity })
  assert.deepEqual(store.get('owner', record.executionId).identity, identity)
  const disk = readFileSync(join(directory, 'ai-executions.json'), 'utf8')
  assert.equal(disk.includes('PRIVATE_BUSINESS_BODY'), false)
})


test('Worker SQL progress is not terminal and the structured partial receipt reaches HTTP and history', async t => {
  const f = await fixture(t), document = f.edit('UPDATE records SET id=2; UPDATE records SET id=3 /* FIXTURE_PROGRESS */')
  const response = await f.api({ action: 'execution-document-run', revision: document.revision })
  assert.notEqual(response.status, 200)
  assert.equal(response.body.effect, 'unknown'); assert.equal(response.body.phase, 'execute')
  assert.equal(response.body.category, 'transport-or-interruption'); assert.equal(response.body.databaseCode, 'ECONNRESET')
  assert.deepEqual(response.body.steps.map(step => step.status), ['succeeded', 'unknown'])
  assert.deepEqual(f.store.get('owner', response.body.executionId, true).result.steps, response.body.steps)
  assert.equal(f.sent().length, 1)
  assert.equal(f.sent()[0].lane, 'manual', 'Worker receives trusted human lane at the outer message boundary')
})

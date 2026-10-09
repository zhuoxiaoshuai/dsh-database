import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ConnectionService } from '../src/host/connection-service.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { ConversationWorkbenchStore } from '../src/host/conversation-workbench-store.ts'
import { createSqlTextExecution } from '../src/host/data-sources/sql-execution.ts'
import { mysqlDialect } from '../src/host/data-sources/mysql/driver.mjs'
import { oracleDialect } from '../src/host/data-sources/oracle/driver.mjs'
import { writeDriverError } from '../src/host/data-sources/sql-write-error.mjs'
import { runOperation } from '../src/host/operation-runtime.ts'
import { classifySqlInterruption } from '../src/host/sql-operation.ts'
import { saveDmlOperations } from '../src/client/execute-dml.ts'
import { applyExecutionResult, displayFromLatest } from '../src/shared/query-sync.ts'
import { emptyExecutionDocument, updateExecutionDocument } from '../src/shared/execution-document.ts'
import { sql as oracleSql } from '../src/host/data-sources/oracle/driver.mjs'
import { connectionInput, temporaryDirectory } from './helpers.mjs'

async function fixture(t, dialect = 'mysql') {
  const directory = temporaryDirectory(t, 'root-repair-')
  const executions = new ExecutionStore(directory)
  const service = new ConnectionService(() => true, directory, pathToFileURL(join(process.cwd(), 'test/fixtures/database-worker.mjs')), undefined, executions)
  t.after(() => service.dispose())
  const connection = await service.open('owner', connectionInput({ dialect }), false)
  return { directory, executions, service, connection }
}

test('atomic text, target and user control advance exactly one revision', () => {
  const before = emptyExecutionDocument('mysql', { schema: 'old' })
  const after = updateExecutionDocument(before, 'SELECT 1', 'user', before.revision, { schema: 'new' })
  assert.equal(after.revision, before.revision + 1); assert.equal(after.controller, 'user'); assert.equal(after.context.schema, 'new')
  assert.equal(updateExecutionDocument(after, after.text, 'user', after.revision, after.context), after)
  assert.throws(() => updateExecutionDocument(after, 'stale', 'user', before.revision), /变化/)
})

for (const dialect of ['mysql', 'oracle']) test(`${dialect} canonical document accepts context atomically and rejects missing revisions`, async t => {
  const { service, connection } = await fixture(t, dialect), id = connection.id, gen = connection.generation
  const before = service.getExecutionDocument('owner', id, gen)
  assert.throws(() => service.updateExecutionDocument('owner', id, 'SELECT 1', 'user'), /修订/)
  assert.throws(() => service.controlExecutionDocument('owner', id, 'user', undefined, gen), /修订/)
  const after = service.updateExecutionDocument('owner', id, 'SELECT 1', 'user', before.revision, gen, { schema: 'other' })
  assert.equal(after.revision, before.revision + 1); assert.equal(service.getSharedQuery('owner', id).schema, 'other')
  const raw = JSON.parse(readFileSync(service.conversations.pathFor('owner'), 'utf8'))
  assert.equal(raw.version, 2); assert.equal(raw.workbenches[id].sharedQuery, undefined); assert.equal(raw.workbenches[id].aiDocument.text, 'SELECT 1')
  const save = service.conversations.save.bind(service.conversations)
  service.conversations.save = () => { throw new Error('disk failure') }
  assert.throws(() => service.updateExecutionDocument('owner', id, 'SELECT 2', 'user', after.revision, gen, { schema: 'app' }), /disk failure/)
  assert.deepEqual(service.getExecutionDocument('owner', id, gen), after, 'failed storage must leave no partial text or target update')
  service.conversations.save = save
})

for (const dialect of ['mysql', 'oracle']) for (const environment of ['sit', 'uat', 'pvt']) test(`${dialect} ${environment} trusted identity sets permission and quota across both SQL pages`, async () => {
  const execution = createSqlTextExecution(dialect), binding = { dialect, environment, database: 'app' }
  for (const entry of ['manual-query', 'shared-query']) {
    const prepared = execution.prepareText('UPDATE records SET id=2', { schema: 'app' }, { sourceKind: 'sql', entry })
    prepared.input.lane = 'query'
    await execution.authorize(prepared, 'user', binding, { sourceKind: 'sql', entry })
    assert.equal(prepared.queue, 'manual'); assert.equal(prepared.input.lane, 'manual')
  }
  const ai = execution.prepareText('UPDATE records SET id=2', { schema: 'app' }, { sourceKind: 'sql', entry: 'shared-query' })
  if (environment === 'sit') await execution.authorize(ai, 'ai', binding, { sourceKind: 'sql', entry: 'shared-query' })
  else await assert.rejects(execution.authorize(ai, 'ai', binding, { sourceKind: 'sql', entry: 'shared-query' }), /只读/)
  assert.equal(ai.queue, 'ai'); assert.equal(ai.input.lane, 'query')
})

test('selected SQL leaves full document intact and records both texts', async t => {
  const { service, connection, executions } = await fixture(t)
  const before = service.getExecutionDocument('owner', connection.id)
  const document = service.updateExecutionDocument('owner', connection.id, 'SELECT id FROM records; SELECT 2', 'user', before.revision)
  const result = await service.runExecutionDocument('owner', connection.id, connection.generation, document.revision, undefined, 'SELECT id FROM records')
  assert.deepEqual(service.getExecutionDocument('owner', connection.id), document)
  const record = executions.get('owner', result.executionId)
  assert.equal(record.documentText, document.text); assert.equal(record.executedSql, 'SELECT id FROM records')
  await assert.rejects(service.runExecutionDocument('owner', connection.id, connection.generation, document.revision, undefined, 'DELETE FROM records'), /不属于/)
})

test('v1 migration backs up and retains query tabs, drafts, history and selected target', async t => {
  const f = await fixture(t), id = f.connection.id
  await f.service.dispose()
  const store = new ConversationWorkbenchStore(f.directory), path = store.pathFor('owner')
  mkdirSync(join(f.directory, 'conversation-workbenches'), { recursive: true })
  writeFileSync(path, JSON.stringify({ version: 1, workbenches: { [id]: { schema: 'workspace', sharedQuery: { sql: 'SELECT 1', schema: 'collab', revision: 7, controller: 'user' }, queryTabs: [{ id: 'q', name: 'draft', sql: 'SELECT 2' }], history: ['SELECT 3'] } } }))
  const service = new ConnectionService(() => true, f.directory)
  t.after(() => service.dispose())
  const document = service.getExecutionDocument('owner', id)
  assert.equal(document.text, 'SELECT 1'); assert.equal(document.context.schema, 'collab'); assert.equal(document.revision, 7)
  assert.ok(existsSync(path + '.v1.bak'))
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(saved.workbenches[id].sharedQuery, undefined); assert.equal(saved.workbenches[id].queryTabs[0].sql, 'SELECT 2'); assert.deepEqual(saved.workbenches[id].history, ['SELECT 3'])
  assert.deepEqual(service.getExecutionDocument('owner', id), document)
})

test('more than 200 conversations survive cache eviction and isolated callers cannot mutate cached truth', t => {
  const directory = temporaryDirectory(t, 'root-lru-'), store = new ConversationWorkbenchStore(directory)
  for (let i = 0; i < 205; i++) store.save('c' + i, { workbenches: { db: { aiDocument: { ...emptyExecutionDocument('mysql', { schema: 'app' }), text: 'SELECT ' + i, controller: 'user' } } } }, new Set(['db']))
  const old = store.load('c0'); assert.equal(old.workbenches.db.aiDocument.text, 'SELECT 0'); assert.equal(old.workbenches.db.aiDocument.controller, 'user')
  old.workbenches.db.aiDocument.text = 'corrupted caller'; assert.equal(store.load('c0').workbenches.db.aiDocument.text, 'SELECT 0')
})

test('storage preserves ordinary dpapi business text and removes credential fields structurally', t => {
  const directory = temporaryDirectory(t, 'root-text-'), executions = new ExecutionStore(directory)
  const row = executions.create({ conversationId: 'owner', operation: 'query', sql: "SELECT 'dpapi: ordinary password column'", draft: { kind: 'query', sql: 'SELECT 1', password: 'secret credential', protectedPassword: 'dpapi:cipher' } })
  executions.complete(row.executionId, 'succeeded')
  const disk = readFileSync(join(directory, 'ai-executions.json'), 'utf8')
  assert.ok(disk.includes('dpapi: ordinary password column')); assert.ok(!disk.includes('secret credential')); assert.ok(!disk.includes('dpapi:cipher'))
})

test('restart recovery never replays unfinished requests and persists deterministic terminal reasons', t => {
  const directory = temporaryDirectory(t, 'root-recovery-'), executions = new ExecutionStore(directory)
  const pending = executions.create({ conversationId: 'owner', operation: 'queued', generation: 'old' })
  const sent = executions.create({ conversationId: 'owner', operation: 'write', generation: 'old' })
  executions.transition(sent.executionId, 'running'); executions.event(sent.executionId, 'dispatched')
  const restored = new ExecutionStore(directory)
  assert.equal(restored.get('owner', pending.executionId).status, 'cancelled'); assert.equal(restored.get('owner', sent.executionId).status, 'unknown')
  assert.match(restored.get('owner', sent.executionId).conclusion, /未自动重放/)
  const disk = JSON.parse(readFileSync(join(directory, 'ai-executions.json'), 'utf8'))
  assert.ok(disk.records.every(row => ['cancelled', 'unknown'].includes(row.status)))
})

test('capacity pressure keeps every active record and immutable in-memory snapshot', t => {
  const directory = temporaryDirectory(t, 'root-budget-'), executions = new ExecutionStore(directory)
  const text = 'x'.repeat(65536), ids = []
  for (let i = 0; i < 105; i++) ids.push(executions.create({ conversationId: 'owner', connectionId: 'db', operation: 'query', documentText: text }).executionId)
  assert.equal(executions.list('owner').length, 105)
  assert.ok(ids.every(id => executions.get('owner', id).status === 'preparing' && executions.get('owner', id).documentText === text))
  const disk = readFileSync(join(directory, 'ai-executions.json'))
  assert.ok(disk.length <= 2 * 1024 * 1024); assert.equal(JSON.parse(disk).records.length, 105)
})

test('structured driver rejection and missing write receipt produce different outcomes', () => {
  const mysql = writeDriverError({ code: 'ER_DUP_ENTRY' }, 'duplicate'), oracle = writeDriverError({ errorNum: 1 }, 'duplicate')
  assert.equal(mysql.effect, 'none'); assert.equal(oracle.effect, 'none')
  const lost = writeDriverError({ code: 'ECONNRESET' }, 'lost')
  assert.equal(lost.effect, 'unknown')
  assert.equal(classifySqlInterruption(lost, { dispatched: true, aborted: false, write: true }), 'unknown')
  assert.equal(classifySqlInterruption(mysql, { dispatched: true, aborted: false, write: true }), 'failed')
})

test('partial batch receipts survive failed lifecycle, reload and cannot erase committed steps', async t => {
  const directory = temporaryDirectory(t, 'root-batch-'), executions = new ExecutionStore(directory)
  const steps = [{ index: 0, sql: 'INSERT INTO t VALUES (1)', status: 'succeeded', affectedRows: 1 }, { index: 1, sql: 'UPDATE t SET id=2', status: 'unknown' }, { index: 2, sql: 'SELECT 1', status: 'not-run' }]
  await assert.rejects(runOperation(executions, { owner: 'owner', connectionId: 'db', generation: 'g', connectionName: 'db', sourceId: 'mysql', environment: 'sit' }, { operation: 'sql', title: 'batch', initiator: 'user', type: 'write' }, async (_signal, dispatched) => { dispatched(); throw Object.assign(new Error('lost receipt'), { effect: 'unknown', steps }) }, () => '', undefined, undefined, { classifyInterruption: classifySqlInterruption }), /lost receipt/)
  const row = executions.list('owner')[0]
  assert.equal(row.status, 'unknown'); assert.deepEqual(executions.get('owner', row.executionId, true).result.steps, steps)
  assert.deepEqual(new ExecutionStore(directory).get('owner', row.executionId, true).result.steps, steps)
})

test('shared grid coordinator consumes successes and prohibits unknown resubmission', async () => {
  const operations = [{ kind: 'insert', values: { id: '1' } }, { kind: 'insert', values: { id: '2' } }], sent = [], committed = []
  await assert.rejects(saveDmlOperations(operations, async op => { sent.push(op.values.id); if (op.values.id === '2') throw Object.assign(new Error('lost'), { effect: 'unknown' }) }, op => committed.push(op.values.id)), /lost/)
  assert.deepEqual(committed, ['1']); assert.equal(operations.length, 1)
  await assert.rejects(saveDmlOperations(operations, async op => sent.push(op.values.id), () => {}), /不能再次提交/)
  assert.deepEqual(sent, ['1', '2'])
})

test('same text in another target, revision or generation rejects late success and late failure', () => {
  const result = { columns: ['id'], rows: [['1']], truncated: false, elapsedMs: 1 }
  const opts = { connectionId: 'db', controller: 'user', sql: 'SELECT 1', queryRevision: 5, schema: 'new', generation: 'g2' }
  for (const type of ['EXECUTION_FINISHED', 'EXECUTION_FAILED']) for (const stale of [{ generation: 'g1' }, { schema: 'old' }, { queryRevision: 4 }]) {
    const event = { ...opts, type, executionId: 'old', executedSql: opts.sql, result, ...stale }
    assert.equal(applyExecutionResult(undefined, event, opts), undefined)
  }
  assert.equal(displayFromLatest('db', { sql: opts.sql, schema: 'new', revision: 5 }, { executionId: 'old', connectionId: 'db', executedSql: opts.sql, queryRevision: 5, schema: 'old', generation: 'g2', type: 'query', result }, 'g2'), undefined)
})

test('Oracle statistics use escaped literal values and preserve quoted-name case', () => {
  const statement = oracleSql.analyzeTable('', "Mixed'Owner", "Table'); DELETE FROM t; --")
  assert.equal(statement, "BEGIN DBMS_STATS.GATHER_TABLE_STATS(ownname => 'Mixed''Owner', tabname => 'Table''); DELETE FROM t; --'); END;")
})

test('async storage failure keeps the latest snapshot and recovers on its bounded retry', async t => {
  const directory = temporaryDirectory(t, 'root-retry-'), path = join(directory, 'ai-executions.json')
  const executions = new ExecutionStore(directory, 'async')
  t.after(() => executions.dispose())
  mkdirSync(path)
  const row = executions.create({ conversationId: 'owner', operation: 'query' })
  executions.complete(row.executionId, 'succeeded')
  const deadline = Date.now() + 2000
  while (!executions.storageDegraded && Date.now() < deadline) await new Promise(done => setTimeout(done, 20))
  assert.equal(executions.storageDegraded, true)
  assert.equal(executions.get('owner', row.executionId).status, 'succeeded')
  executions.annotate(row.executionId, { title: 'latest snapshot during retry' })
  rmdirSync(path)
  const retryDeadline = Date.now() + 2500
  while (executions.storageDegraded && Date.now() < retryDeadline) await new Promise(done => setTimeout(done, 30))
  assert.equal(executions.storageDegraded, false)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).records[0].status, 'succeeded')
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).records[0].title, 'latest snapshot during retry')
})

test('SQL AI pressure leaves the reserved manual slot usable', async t => {
  const { service, executions, connection } = await fixture(t)
  const document = service.updateExecutionDocument('owner', connection.id, 'SELECT 1 /* SLEEP_TEST */', 'ai',
    service.getExecutionDocument('owner', connection.id).revision, connection.generation, { schema: 'app' })
  const ai = () => service.runSharedQuery('owner', { connectionId: connection.id, generation: connection.generation,
    schema: 'app', sql: document.text, revision: document.revision, initiator: 'ai', purpose: 'verify' })
  const active = [ai(), ai()]
  const deadline = Date.now() + 1000
  while (executions.list('owner').filter(row => row.events.some(event => event.kind === 'dispatched')).length < 2 && Date.now() < deadline) await new Promise(done => setTimeout(done, 10))
  assert.equal(executions.list('owner').filter(row => row.events.some(event => event.kind === 'dispatched')).length, 2)
  await assert.rejects(ai(), /已为人工查询保留通道/)
  const manual = await service.request('owner', connection.id, connection.generation, 'query', { sql: 'SELECT 2', schema: 'app' })
  assert.ok(manual.rows.length)
  assert.equal(executions.list('owner').filter(row => row.status === 'running').length, 2, 'manual query finishes while both AI requests are still dispatched')
  await Promise.all(active)
})

test('late partial receipt enriches an already unknown cancelled record without changing its terminal fact', async t => {
  const directory = temporaryDirectory(t, 'root-late-partial-'), executions = new ExecutionStore(directory)
  const row = executions.create({ conversationId: 'owner', operation: 'sql' })
  executions.transition(row.executionId, 'running'); executions.event(row.executionId, 'dispatched')
  executions.cancel('owner', row.executionId, true)
  const steps = [{ index: 0, sql: 'INSERT one', status: 'succeeded', affectedRows: 1 }, { index: 1, sql: 'INSERT two', status: 'unknown' }]
  executions.complete(row.executionId, 'unknown', 'cancelled after commit', { columns: [], rows: [], truncated: false, elapsedMs: 0, steps })
  assert.equal(executions.get('owner', row.executionId).status, 'unknown')
  assert.deepEqual(executions.get('owner', row.executionId, true).result.steps, steps)
  await executions.dispose()
})


for (const source of ['mysql', 'oracle']) for (const stage of ['open', 'prepare', 'verify']) test(`${source} cancellation during ${stage} cleans a late connection and sends zero writes`, async () => {
  const text = readFileSync(new URL('../src/host/query.mjs', import.meta.url), 'utf8')
  const functionText = text.slice(text.indexOf('export async function executeDml'), text.indexOf('// SQL 页统一入口')).replace('export ', '')
  const abort = new AbortController(), calls = [], connection = {}
  const driver = { openQuery: async () => { calls.push('open'); if (stage === 'open') abort.abort(); return connection },
    prepareWrite: async () => { calls.push('prepare'); if (stage === 'prepare') abort.abort() },
    verifyWritableTargets: async () => { calls.push('verify'); if (stage === 'verify') abort.abort() },
    cancel: () => calls.push('cancel'), executeWrite: async () => { calls.push('write'); return 1 }, destroy: async db => { assert.equal(db, connection); calls.push('destroy') } }
  const run = new Function('getDialect', 'isWritableEnvironment', 'authorizeStatement', 'cancelledError', 'assertWritableTargets', functionText + '; return executeDml')(
    () => driver, () => true, async () => ({ kind: 'write', sql: 'UPDATE records SET id=2', targets: [] }), message => new Error(message), () => {})
  await assert.rejects(run({ lane: 'manual', sql: 'UPDATE records SET id=2', schema: 'app' }, { dialect: source }, abort.signal), error => error.effect === 'none' && error.cancelled)
  assert.ok(!calls.includes('write')); assert.equal(calls.at(-1), 'destroy')
})

for (const [name, driver, db, code] of [
  ['mysql', mysqlDialect, { promise: () => ({ query: async () => { throw { code: 'ER_DUP_ENTRY' } } }) }, 'ER_DUP_ENTRY'],
  ['oracle', oracleDialect, { execute: async () => { throw { errorNum: 1 } } }, 'ORA-00001'],
]) test(`${name} actual write adapter retains definitive rejection classification`, async () => {
  await assert.rejects(driver.executeWrite(db, 'INSERT INTO records VALUES (1)'), error => error.effect === 'none' && error.databaseCode === code && error.category === 'database-rejection')
})

test('MySQL write preparation bounds both row and metadata locks without losing driver deadlines', async () => {
  const queries = [], connection = { promise: () => ({ query: async value => { queries.push(value) } }) }
  await mysqlDialect.prepareWrite(connection, 'app')
  assert.ok(queries.every(value => typeof value.timeout === 'number' && value.timeout > 0))
  assert.match(queries.map(value => value.sql).join(';'), /innodb_lock_wait_timeout=10, SESSION lock_wait_timeout=10/)
})

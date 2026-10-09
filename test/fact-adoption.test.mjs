import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { ConnectionService } from '../src/host/connection-service.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { connectionApi } from '../src/host/connection-api.ts'
import { memoryPasswordProtector } from '../src/password-protector.ts'
import { matchesResultOwner } from '../src/shared/query-sync.ts'

async function fixture(t, dialect) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-fact-adoption-'))
  const executions = new ExecutionStore(directory)
  const service = new ConnectionService(() => true, directory, undefined, memoryPasswordProtector, executions, undefined,
    () => new Worker(new URL('../test/fixtures/' + (dialect === 'redis' ? 'redis-queue-worker.mjs' : 'sql-operation-worker.mjs'), import.meta.url), { workerData: { marker: join(directory, 'dispatch.jsonl') } }))
  t.after(async () => { await service.dispose(); await executions.dispose(); rmSync(directory, { recursive: true, force: true }) })
  const input = { name: dialect, dialect, host: 'fixture.test', port: dialect === 'redis' ? 6379 : 3306,
    database: dialect === 'redis' ? '0' : 'app', oracleMode: 'service', redisMode: 'standalone', username: 'reader', password: 'fixture', environment: 'uat' }
  const connection = await service.open('owner', input, false)
  return { service, executions, input, connection }
}
async function api(f, body) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]); request.method = 'POST'; request.headers = { 'content-type': 'application/json' }
  const response = Object.assign(new EventEmitter(), { destroyed: false, writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body); this.writableEnded = true } })
  await connectionApi(f.service, f.executions, 'owner', request, response)
  return { status: response.status, body: response.body }
}

for (const dialect of ['mysql', 'oracle']) {
  test(dialect + ' canonical and legacy HTTP enforce the same control, revision and generation', async t => {
    const f = await fixture(t, dialect)
    const { id, generation } = f.connection
    const document = f.service.updateExecutionDocument('owner', id, 'SELECT 1', 'ai', f.service.getExecutionDocument('owner', id).revision, generation, { schema: 'app' })
    const base = { id, generation, revision: document.revision }
    for (const action of ['execution-document-run', 'shared-query-run']) {
      const response = await api(f, { action, ...base, sql: 'SELECT 1', schema: 'app' })
      assert.equal(response.status, 400); assert.match(response.body.error, /接管/)
    }
    assert.equal(f.executions.list('owner').length, 0)
    const reconnected = await f.service.open('owner', f.input, false, id)
    assert.equal(reconnected.id, id); assert.notEqual(reconnected.generation, generation)
    for (const action of ['execution-document-update', 'shared-query-update', 'execution-document-control', 'shared-query-control']) {
      for (const identity of [{ generation }, { generation: undefined }, { generation: reconnected.generation, revision: undefined }]) {
        const response = await api(f, { action, ...base, ...identity, text: 'SELECT 99', context: { schema: 'other' }, patch: { sql: 'SELECT 99', schema: 'other' }, controller: 'user' })
        assert.equal(response.status, 400, action + JSON.stringify(identity))
      }
    }
    assert.equal(f.service.getExecutionDocument('owner', id).text, 'SELECT 1')
    const edited = await api(f, { action: 'shared-query-update', id, generation: reconnected.generation, revision: document.revision,
      patch: { sql: 'SELECT 2', schema: 'other' } })
    assert.equal(edited.status, 200); assert.equal(edited.body.sharedQuery.controller, 'user')
    const current = f.service.getExecutionDocument('owner', id)
    assert.equal(current.text, 'SELECT 2'); assert.equal(current.context.schema, 'other'); assert.equal(current.revision, document.revision + 1)
    await f.service.disconnect('owner', id)
    const offline = await api(f, { action: 'execution-document-update', id, revision: current.revision, text: 'SELECT offline', context: { schema: 'other' } })
    assert.equal(offline.status, 200)
    assert.equal((await api(f, { action: 'execution-document-run', id, revision: offline.body.document.revision })).status, 400)
  })
  test(dialect + ' direct success and failure carry the same immutable identity as events', async t => {
    const f = await fixture(t, dialect)
    const { id, generation } = f.connection
    for (const text of ['SELECT 1', 'SELECT FIXTURE_ERROR']) {
      const document = f.service.updateExecutionDocument('owner', id, text, 'user', f.service.getExecutionDocument('owner', id).revision, generation, { schema: 'app' })
      const response = await api(f, { action: 'execution-document-run', id, generation, revision: document.revision })
      assert.equal(response.status, text.includes('ERROR') ? 400 : 200)
      const owner = { connectionId: id, generation, schema: 'app', sql: text, queryRevision: document.revision, controller: 'user' }
      assert.equal(matchesResultOwner(response.body, owner), true)
      const record = f.executions.list('owner').find(item => item.executionId === response.body.executionId)
      assert.equal(matchesResultOwner(record, owner), true)
    }
  })
}

test('UAT Redis document button is human execution with complete document identity', async t => {
  const f = await fixture(t, 'redis')
  const { id, generation } = f.connection
  const document = f.service.updateExecutionDocument('owner', id, 'PING', 'user', f.service.getExecutionDocument('owner', id).revision, generation, { database: '0' })
  const response = await api(f, { action: 'execution-document-run', id, generation, revision: document.revision })
  assert.equal(response.status, 200)
  assert.equal(matchesResultOwner(response.body, { connectionId: id, generation, context: { database: '0' }, sql: 'PING', queryRevision: document.revision, controller: 'user' }), true)
  assert.equal(f.executions.list('owner')[0].initiator, 'user')
})

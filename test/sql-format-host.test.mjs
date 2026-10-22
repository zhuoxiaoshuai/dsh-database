import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ConnectionService } from '../src/host/connection-service.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { prepareSqlFormat } from '../src/shared/sql-format.ts'
import { connectionInput, temporaryDirectory } from './helpers.mjs'

for (const dialect of ['mysql', 'oracle']) test(`${dialect}: canonical Host range formatting validates content, context and control atomically`, async t => {
  const directory = temporaryDirectory(t, 'sql-format-host-')
  const executions = new ExecutionStore(directory)
  const service = new ConnectionService(() => true, directory, pathToFileURL(join(process.cwd(), 'test/fixtures/database-worker.mjs')), undefined, executions)
  t.after(() => service.dispose())
  const connection = await service.open('owner', connectionInput({ dialect }), false)
  const id = connection.id
  const get = () => service.getExecutionDocument('owner', id)
  const set = text => service.updateExecutionDocument('owner', id, text, 'ai', get().revision, undefined, { schema: 'app' })
  const sql = 'SELECT * FROM t WHERE code IN (A001 A002); SELECT 9;'
  set(sql)
  const before = get()
  const formatRange = { from: sql.indexOf('A001'), to: sql.indexOf('A002') + 4 }
  const result = prepareSqlFormat(sql, dialect, formatRange)
  const request = { text: result.text, generation: connection.generation, revision: before.revision, context: before.context, source: 'format', formatRange }
  for (const bad of [
    { ...request, text: result.text.replace('SELECT 9', 'DELETE FROM t') },
    { ...request, context: { schema: 'other' } },
    { ...request, revision: before.revision - 1 },
    { ...request, generation: 'stale-generation' },
    { ...request, generation: undefined },
    { ...request, formatRange: { from: 0, to: sql.length + 1 } },
    { ...request, formatRange: null },
    { ...request, formatRange: { from: 0, to: 0 } },
    { ...request, source: 'user' },
    { ...request, source: 'system' },
  ]) {
    assert.throws(() => service.updateExecutionDocumentFromBrowser('owner', id, bad))
    assert.deepEqual(get(), before)
  }
  const converted = service.updateExecutionDocumentFromBrowser('owner', id, request)
  assert.equal(converted.text, result.text)
  assert.equal(converted.controller, 'user')
  assert.equal(converted.controllerReason, 'user-edit')
  assert.equal(converted.revision, before.revision + 1)
  assert.deepEqual(converted.context, before.context)
  assert.equal(executions.list('owner').length, 0, 'formatting creates no SQL execution')
  service.controlExecutionDocument('owner', id, 'ai', undefined, undefined, get().revision)
  const original = 'select id from records; SELECT 9;'
  set(original)
  const doc = get()
  const range = { from: 0, to: original.indexOf(';') + 1 }
  const formatted = prepareSqlFormat(original, dialect, range)
  const saved = service.updateExecutionDocumentFromBrowser('owner', id, { text: formatted.text, source: 'format', formatRange: range,
    revision: doc.revision, generation: connection.generation, context: doc.context })
  assert.equal(saved.controller, 'ai', 'SQL whitespace formatting retains AI control')
  assert.equal(saved.text.slice(-10), original.slice(-10))
  // The old projection adapter uses the same validator and cannot bypass control classification.
  const raw = '(001 002)'
  set(raw)
  const legacy = service.updateSharedQueryFromBrowser('owner', id, { source: 'format', revision: get().revision, generation: connection.generation,
    formatRange: { from: 0, to: raw.length }, patch: { sql: "('001', '002')" } })
  assert.equal(legacy.controller, 'user')
})

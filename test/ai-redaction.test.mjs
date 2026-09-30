import test from 'node:test'
import assert from 'node:assert/strict'
import { queryColumnsReliable, redactQueryResult, sanitizeToolError } from '../src/host/ai-redaction.ts'
import { sanitizeDatabaseError } from '../src/host/connect-error.mjs'

test('default allow returns cell values when columns are reliable', () => {
  const out = redactQueryResult({
    sql: 'SELECT note FROM records', tables: ['records'], schema: 'app', connectionId: 'c1',
    columns: ['note'], rows: [['secret']], truncated: false, elapsedMs: 4, executionId: 'e1',
  })
  assert.equal(out.ok, true)
  assert.equal(out.rowCount, 1)
  assert.deepEqual(out.rows[0], ['secret'])
  assert.deepEqual(out.redaction, ['allow'])
})

test('allow mask omit apply per column and join sources omit unreliable sql', () => {
  const allowed = redactQueryResult({
    sql: 'SELECT id, note, extra FROM records', tables: ['records'], schema: 'app', connectionId: 'c1',
    columns: ['id', 'note', 'extra'], rows: [['1', 'secret', 'x']], truncated: false, elapsedMs: 1, executionId: 'e1',
    rules: [
      { column: 'id', action: 'allow' },
      { column: 'note', action: 'mask' },
    ],
  })
  assert.deepEqual(allowed.rows[0][0], '1')
  assert.equal(allowed.rows[0][1].masked, true)
  assert.equal(allowed.rows[0][2], 'x')
  assert.equal(queryColumnsReliable('SELECT a.id FROM records a JOIN other b ON a.id=b.id', 2), false)
  const joined = redactQueryResult({
    sql: 'SELECT a.id FROM records a JOIN other b ON a.id=b.id', tables: ['records', 'other'],
    columns: ['id'], rows: [['1']], truncated: false, elapsedMs: 1, executionId: 'e2',
    rules: [{ column: 'id', action: 'allow' }],
  })
  assert.equal(joined.rows, undefined)
  const expr = redactQueryResult({
    sql: 'SELECT COUNT(id) FROM records', tables: ['records'],
    columns: ['COUNT(id)'], rows: [['2']], truncated: false, elapsedMs: 1, executionId: 'e3',
    rules: [{ column: 'COUNT(id)', action: 'allow' }],
  })
  assert.equal(expr.rows, undefined)
})

test('tool errors never leak connection strings or passwords', () => {
  const text = sanitizeToolError('failed password=hunter2 connectString=(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db)(PORT=1521)))')
  assert.equal(text.includes('hunter2'), false)
  assert.equal(text.includes('HOST=db'), false)
})

test('shared database error sanitizer covers every stored credential form', () => {
  const credentials = sanitizeDatabaseError('pwd: one passwd=two', { maxLength: 400 })
  assert.equal(credentials.includes('one'), false)
  assert.equal(credentials.includes('two'), false)
  assert.match(credentials, /pwd=\*\*\*/)
  const protectedPassword = sanitizeDatabaseError('protectedPassword=sealed, after', { maxLength: 400 })
  assert.equal(protectedPassword.includes('sealed'), false)
  assert.match(protectedPassword, /protectedPassword=\*\*\*/)
  const descriptor = sanitizeDatabaseError('connectString=(DESCRIPTION=(ADDRESS=(HOST=private-db)(PORT=1521)))', { maxLength: 400 })
  assert.equal(descriptor.includes('private-db'), false)
  assert.match(descriptor, /\(DESCRIPTION=\*\*\*\)/)
})

test('tool error sanitizer keeps its redact-before-truncate behavior', () => {
  const text = sanitizeToolError(`protectedPassword=${'s'.repeat(500)},after`)
  assert.equal(text, 'protectedPassword=***')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { format } from 'sql-formatter'
import { parseBrowserQueryUpdate, parseBrowserQueryInitiator, validateBrowserFormat } from '../src/host/sql-browser-request.ts'
import { emptySharedQuery } from '../src/shared/workbench.ts'
import { SQL_FIELD_MAX_LENGTH } from '../src/shared/limits.ts'

test('browser SQL execution cannot claim trusted AI identity', () => {
  for (const value of [undefined, 'user']) assert.equal(parseBrowserQueryInitiator(value), 'user')
  for (const value of ['ai', 'system', '', null, true, {}]) assert.throws(() => parseBrowserQueryInitiator(value))
})

test('browser document patches reject internal fields and malformed values atomically', () => {
  assert.deepEqual(parseBrowserQueryUpdate({}), { source: 'user', patch: {}, revision: undefined })
  assert.deepEqual(parseBrowserQueryUpdate({ patch: { sql: 'SELECT 1', schema: 'app' }, revision: 9 }).patch, { sql: 'SELECT 1', schema: 'app' })
  for (const source of ['ai', 'system', '', null]) assert.throws(() => parseBrowserQueryUpdate({ source }))
  for (const key of ['controller', 'controllerReason', 'revision', 'lastExecutionId', 'lastRun', 'other']) {
    assert.throws(() => parseBrowserQueryUpdate({ patch: { sql: 'SELECT 1', [key]: 'forged' } }))
  }
  for (const patch of [null, [], 'sql', { sql: 1 }, { schema: false }, new Date()]) assert.throws(() => parseBrowserQueryUpdate({ patch }))
  for (const revision of [-1, 1.5, '1', null, Infinity]) assert.throws(() => parseBrowserQueryUpdate({ revision }))
})

for (const [dialect, language, sql] of [
  ['mysql', 'mysql', "select 'a  b' as value /* keep comment */ from `records` where id=1"],
  ['oracle', 'plsql', "select 'a  b' as value /*+ FULL(records) */ from records where id=1"],
]) test(`${dialect} browser format must exactly match the actual dialect and current revision`, () => {
  const current = { ...emptySharedQuery(), sql, schema: 'app', revision: 7, controller: 'ai' }
  const formatted = format(sql, { language })
  validateBrowserFormat(current, { sql: formatted, schema: 'app' }, dialect, 7)
  validateBrowserFormat(current, { sql: formatted }, dialect)
  validateBrowserFormat(current, { sql }, dialect, 7)
  assert.equal(current.controller, 'ai')
  assert.throws(() => validateBrowserFormat(current, { sql: formatted }, dialect, 6), /变化/)
  assert.throws(() => validateBrowserFormat(current, { sql: formatted, schema: 'other' }, dialect), /Schema/)
  assert.throws(() => validateBrowserFormat(current, { sql: formatted.replace('a  b', 'a b') }, dialect), /不一致/)
  assert.throws(() => validateBrowserFormat(current, { sql: formatted + ' -- injected' }, dialect), /不一致/)
  assert.throws(() => validateBrowserFormat(current, { sql: 'x'.repeat(SQL_FIELD_MAX_LENGTH + 1) }, dialect), /上限/)
})

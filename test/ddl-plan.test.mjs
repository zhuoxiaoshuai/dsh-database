import test from 'node:test'
import assert from 'node:assert/strict'
import { createDdlPlan } from '../src/host/ddl-plan.mjs'
const metadata = { columns: [{ name: 'id' }, { name: 'note' }] }
test('DDL serial plan follows table renames and marks data-loss operations', () => {
  const plan = createDdlPlan('mysql', 'business', 'records', [{ kind: 'renameTable', name: 'renamed' }, { kind: 'addColumn', column: { name: 'amount', type: 'DECIMAL(20,4)', nullable: true } }, { kind: 'dropColumn', name: 'note' }], metadata)
  assert.ok(plan.steps[1].sql.includes('`business`.`renamed`')); assert.equal(plan.destructive, true); assert.equal(plan.steps.length, 3)
})
test('DDL rejects arbitrary statements in types, checks, sort-like identifiers and step overflow', () => {
  for (const ops of [[{ kind: 'addColumn', column: { name: 'x', type: 'INT); DROP DATABASE business;--' } }], [{ kind: 'dropDatabase' }], Array.from({ length: 21 }, () => ({ kind: 'comment', comment: 'x' })), [{ kind: 'addConstraint', name: 'x', type: 'check', check: { column: 'id', operator: 'gt', value: '0 OR 1=1' } }]]) assert.throws(() => createDdlPlan('mysql', 'business', 'records', ops, metadata))
})
test('destructive DDL never adds CASCADE or PURGE; literal text stays quoted for both MySQL modes', () => {
  for (const dialect of ['mysql', 'oracle']) { const plan = createDdlPlan(dialect, 'business', 'records', [{ kind: 'truncateTable' }, { kind: 'dropTable' }], metadata); assert.ok(!/CASCADE|PURGE/.test(plan.steps.map(s => s.sql).join(' '))); assert.equal(plan.destructive, true) }
  for (const mode of ['', 'NO_BACKSLASH_ESCAPES']) assert.ok(createDdlPlan('mysql', 'business', 'records', [{ kind: 'comment', comment: "hello\\'world" }], metadata, mode).steps[0].sql.endsWith("world'"))
})

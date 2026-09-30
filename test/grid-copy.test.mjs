import test from 'node:test'
import assert from 'node:assert/strict'
import { cellsInRange, formatCsv, formatInsert, formatTsv, sqlLiteral } from '../src/client/grid-copy/format.ts'

const columns = ['a字段', 'b字段', 'c字段']
const rows = [['a', 'b', '1'], ['e', '2', 'g']]

test('tsv copies fields, values, or both', () => {
  assert.equal(formatTsv(columns, rows, 'fields'), 'a字段\tb字段\tc字段')
  assert.equal(formatTsv(columns, rows, 'values'), 'a\tb\t1\ne\t2\tg')
  assert.equal(formatTsv(columns, rows, 'both'), 'a字段\tb字段\tc字段\na\tb\t1\ne\t2\tg')
  assert.equal(formatTsv(['note'], [[null], ['']], 'values'), 'NULL\n""')
})

test('csv quotes strings and leaves numbers', () => {
  assert.equal(formatCsv(columns, rows, 'fields'), 'a字段,b字段,c字段')
  assert.equal(formatCsv(columns, rows, 'values'), "'a','b',1\n'e',2,'g'")
  assert.equal(formatCsv(columns, rows, 'both'), "a字段,b字段,c字段\n'a','b',1\n'e',2,'g'")
  assert.equal(formatCsv(['note', 'n'], [['a', '2']], 'values', ['varchar(10)', 'int']), "'a',2")
  assert.equal(formatCsv(['note'], [[null]], 'values'), 'NULL')
  assert.equal(sqlLiteral("a'b", 'varchar(10)'), "'a''b'")
})

test('insert quotes identifiers and values', () => {
  assert.equal(
    formatInsert('mysql', 'records', ['a字段', 'c字段'], [['a', '1']], ['varchar(10)', 'int'], 'app'),
    "INSERT INTO `app`.`records` (`a字段`, `c字段`) VALUES ('a', 1);",
  )
  assert.equal(
    formatInsert('oracle', '', ['id'], [['7']]),
    'INSERT INTO "_result" ("id") VALUES (7);',
  )
  assert.equal(
    formatInsert('mysql', 'records', ['note'], [['a'], ['b']]),
    "INSERT INTO `records` (`note`) VALUES ('a');\nINSERT INTO `records` (`note`) VALUES ('b');",
  )
})

test('range copy keeps edits and draft rows in screen order', () => {
  const picked = cellsInRange(
    { columns: ['id', 'note'], rows: [['1', 'old']] },
    [{ values: { id: '', note: 'new' } }],
    { '1': { note: 'edited' } },
    ['id'],
    { r1: -1, c1: 1, r2: 0, c2: 1 },
  )
  assert.deepEqual(picked, { columns: ['note'], rows: [['new'], ['edited']], types: [''] })
  const bothDrafts = cellsInRange(
    { columns: ['id', 'note'], rows: [['1', 'old']] },
    [{ values: { note: 'first' } }, { values: { note: 'second' } }],
    {},
    [],
    { r1: -1, c1: 1, r2: 0, c2: 1 },
  )
  assert.deepEqual(bothDrafts.rows, [['first'], ['second'], ['old']])
})

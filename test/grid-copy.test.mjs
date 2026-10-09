import test from 'node:test'
import assert from 'node:assert/strict'
import { cellsInSelection, formatCommaList, formatInsert, formatTsv, sqlLiteral } from '../src/client/grid-copy/format.ts'
import { selectColumn, selectionContains, selectionRows } from '../src/client/grid-copy/selection.ts'
import { placeCopyMenu } from '../src/client/grid-copy/placement.ts'

const columns = ['a字段', 'b字段', 'c字段']
const rows = [['a', 'b', '1'], ['e', '2', 'g']]

test('tsv copies fields, values, or both', () => {
  assert.equal(formatTsv(columns, rows, 'fields'), 'a字段\tb字段\tc字段')
  assert.equal(formatTsv(columns, rows, 'values'), 'a\tb\t1\ne\t2\tg')
  assert.equal(formatTsv(columns, rows, 'both'), 'a字段\tb字段\tc字段\na\tb\t1\ne\t2\tg')
  assert.equal(formatTsv(['note'], [[null], ['']], 'values'), 'NULL\n""')
})

test('comma list flattens rows, quotes strings and leaves numbers', () => {
  assert.equal(formatCommaList(columns, rows, 'fields'), 'a字段,b字段,c字段')
  assert.equal(formatCommaList(columns, rows, 'values'), "'a','b',1,'e',2,'g'")
  assert.equal(formatCommaList(columns, rows, 'both'), "a字段,b字段,c字段\n'a','b',1,'e',2,'g'")
  assert.equal(formatCommaList(['note', 'n'], [['a', '2']], 'values', ['varchar(10)', 'int']), "'a',2")
  assert.equal(formatCommaList(['note'], [[null]], 'values'), 'NULL')
  assert.equal(formatCommaList(['note'], [['a'], ['b']], 'values'), "'a','b'")
  assert.equal(formatCommaList(['note'], [["a'b"], [null], ['']], 'values'), "'a''b',NULL,''")
  assert.equal(formatCommaList(['note'], [], 'both'), 'note\n')
  assert.equal(sqlLiteral("a'b", 'varchar(10)'), "'a''b'")
})

test('column selection toggles arbitrary columns and extends in either direction', () => {
  let selection = selectColumn(undefined, 2, null, false, false)
  selection = selectColumn(selection, 0, 2, false, true)
  assert.deepEqual(selection.columns, [0, 2])
  selection = selectColumn(selection, 2, 0, false, true)
  assert.deepEqual(selection.columns, [0])
  selection = selectColumn(selection, 0, 0, false, true)
  assert.deepEqual(selection.columns, [])
  assert.deepEqual(selectionRows(selection, 2, 3), [])
  assert.deepEqual(selectColumn(selection, 0, 2, true, false).columns, [0, 1, 2])
  assert.deepEqual(selectColumn(selection, 2, 0, true, false).columns, [0, 1, 2])
  assert.deepEqual(selectColumn(selection, 1, null, true, false).columns, [1])
})

test('discontinuous columns copy in table order with draft and changed values', () => {
  const selection = { kind: 'columns', columns: [2, 0] }
  const picked = cellsInSelection({ columns: ['id', 'ignored', 'note'], rows: [['1', 'skip', 'old']] },
    [{ values: { id: '7', note: 'draft' } }, { values: { id: '8', note: '' } }],
    { '1': { note: 'edited' } }, ['id'], selection, ['int', 'varchar', 'varchar'])
  assert.deepEqual(picked, { columns: ['id', 'note'], rows: [['7', 'draft'], ['8', ''], ['1', 'edited']], types: ['int', 'varchar'] })
  assert.equal(selectionContains(selection, { row: -2, col: 2 }, 2, 1), true)
  assert.equal(selectionContains(selection, { row: 0, col: 1 }, 2, 1), false)
  assert.equal(selectionContains(selection, { row: 1, col: 2 }, 2, 1), false)
  assert.deepEqual(cellsInSelection({ columns: ['id', 'note'], rows: [] }, [], {}, [], selection), { columns: ['id'], rows: [], types: [''] })
})

test('range highlighting and copying agree on reverse draft row order', () => {
  const selection = { kind: 'range', r1: 1, c1: 2, r2: -2, c2: 0 }
  const rows = selectionRows(selection, 3, 2)
  assert.deepEqual(rows, [-2, -3, 0, 1])
  for (const row of [-1, -2, -3, 0, 1, 2]) {
    assert.equal(selectionContains(selection, { row, col: 1 }, 3, 2), rows.includes(row))
  }
})

test('copy popup placement keeps both levels inside viewport without overlap', () => {
  const main = { width: 208, height: 280 }, fly = { width: 156, height: 102 }, viewport = { width: 1200, height: 800 }
  for (const [x, y] of [[8, 8], [1195, 8], [8, 795], [1195, 795], [180, 650]]) {
    const p = placeCopyMenu(x, y, main, fly, 200, viewport)
    assert.equal(p.inline, false)
    assert.ok(p.left >= 8 && p.left + main.width <= viewport.width - 8)
    assert.ok(p.top >= 8 && p.top + main.height <= viewport.height - 8)
    assert.ok(p.flyLeft >= 8 && p.flyLeft + fly.width <= viewport.width - 8)
    assert.ok(p.flyTop >= 8 && p.flyTop + fly.height <= viewport.height - 8)
    assert.ok(p.flyLeft >= p.left + main.width + 6 || p.flyLeft + fly.width + 6 <= p.left)
  }
  const shifted = placeCopyMenu(100, 10, main, fly, 100, { width: 400, height: 500 })
  assert.equal(shifted.inline, false)
  assert.ok(shifted.flyLeft >= shifted.left + main.width + 6)
  assert.equal(placeCopyMenu(250, 10, main, fly, 100, { width: 320, height: 500 }).inline, true)
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
  const picked = cellsInSelection(
    { columns: ['id', 'note'], rows: [['1', 'old']] },
    [{ values: { id: '', note: 'new' } }],
    { '1': { note: 'edited' } },
    ['id'],
    { kind: 'range', r1: -1, c1: 1, r2: 0, c2: 1 },
  )
  assert.deepEqual(picked, { columns: ['note'], rows: [['new'], ['edited']], types: [''] })
  const bothDrafts = cellsInSelection(
    { columns: ['id', 'note'], rows: [['1', 'old']] },
    [{ values: { note: 'first' } }, { values: { note: 'second' } }],
    {},
    [],
    { kind: 'range', r1: -1, c1: 1, r2: 0, c2: 1 },
  )
  assert.deepEqual(bothDrafts.rows, [['first'], ['second'], ['old']])
})

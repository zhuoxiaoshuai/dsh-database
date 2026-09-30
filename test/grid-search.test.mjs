import test from 'node:test'
import assert from 'node:assert/strict'
import { searchCells } from '../src/client/grid-search/match.ts'

const result = {
  columns: ['id', 'name', 'note'],
  rows: [
    ['1', 'Ada', 'nullable'],
    ['2', 'bob', null],
    ['3', 'OLD', 'x'.repeat(90) + 'Tail'],
  ],
}

test('matches raw values without case, and not a short prefix of NULL', () => {
  assert.deepEqual(searchCells({ result, draftRows: [], changed: {}, primaryKeys: ['id'], query: 'ada' }), [{ row: 0, col: 1 }])
  assert.deepEqual(searchCells({ result, draftRows: [], changed: {}, primaryKeys: ['id'], query: 'TAIL' }), [{ row: 2, col: 2 }])
  assert.deepEqual(searchCells({ result, draftRows: [], changed: {}, primaryKeys: ['id'], query: 'nu' }), [{ row: 0, col: 2 }])
  assert.deepEqual(searchCells({ result, draftRows: [], changed: {}, primaryKeys: [], query: '  ' }), [])
})

test('NULL matches only the keyword NULL, including the text NULL', () => {
  const withText = {
    columns: ['note'],
    rows: [['NULL'], [null], ['ok']],
  }
  assert.deepEqual(searchCells({ result: withText, draftRows: [], changed: {}, primaryKeys: [], query: 'Null' }), [
    { row: 0, col: 0 },
    { row: 1, col: 0 },
  ])
  assert.deepEqual(searchCells({ result: withText, draftRows: [], changed: {}, primaryKeys: [], query: 'n' }), [
    { row: 0, col: 0 },
  ])
})

test('draft rows and unsaved values replace the stored cell', () => {
  const hits = searchCells({
    result,
    draftRows: [
      { values: { id: null, name: 'Draft', note: 'first' } },
      { values: { id: null, name: 'second', note: 'zzz' } },
    ],
    changed: { '3': { name: 'Edited' } },
    primaryKeys: ['id'],
    query: 'draft',
  })
  assert.deepEqual(hits, [{ row: -1, col: 1 }])
  assert.deepEqual(searchCells({
    result,
    draftRows: [{ values: { name: 'Draft' } }, { values: { name: 'second' } }],
    changed: { '3': { name: 'Edited' } },
    primaryKeys: ['id'],
    query: 'edited',
  }), [{ row: 2, col: 1 }])
  assert.deepEqual(searchCells({
    result,
    draftRows: [{ values: { name: 'Draft' } }, { values: { name: 'second' } }],
    changed: { '3': { name: 'Edited' } },
    primaryKeys: ['id'],
    query: 'old',
  }), [])
  assert.deepEqual(searchCells({
    result,
    draftRows: [{ values: { name: 'Draft' } }, { values: { name: 'second' } }],
    changed: {},
    primaryKeys: ['id'],
    query: 'second',
  }), [{ row: -2, col: 1 }])
})

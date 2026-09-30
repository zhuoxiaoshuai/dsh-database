import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compareDbIntegers, compareDbValues, dbRowClass, nextDbSort, sortDbRows } from '../src/client/workspace/source/db-table.ts'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('integer columns preserve adjacent offsets beyond the safe Number range and stable ties', () => {
  const values = ['9007199254740993', '9007199254740992', '-9007199254740993', '0', null, '', '9007199254740992']
  const rows = values.map((n, id) => ({ n, id }))
  const asc = sortDbRows(rows, 'n', 'asc', row => row.n, compareDbIntegers)
  assert.deepEqual(asc.map(row => row.n), ['-9007199254740993', '0', '9007199254740992', '9007199254740992', '9007199254740993', null, ''])
  assert.deepEqual(asc.filter(row => row.n === '9007199254740992').map(row => row.id), [1, 6])
  assert.deepEqual(sortDbRows(rows, 'n', 'desc', row => row.n, compareDbIntegers).map(row => row.n), ['9007199254740993', '9007199254740992', '9007199254740992', '0', '-9007199254740993', null, ''])
})

test('column sort cycles ascending, descending, then clears', () => {
  assert.deepEqual(nextDbSort(undefined, undefined, 'lag'), { key: 'lag', order: 'asc' })
  assert.deepEqual(nextDbSort('lag', 'asc', 'lag'), { key: 'lag', order: 'desc' })
  assert.deepEqual(nextDbSort('lag', 'desc', 'lag'), {})
  assert.deepEqual(nextDbSort('lag', 'asc', 'end'), { key: 'end', order: 'asc' })
})

test('numbers sort numerically and empty values stay last', () => {
  const rows = [{ n: '10' }, { n: 2 }, { n: null }, { n: '' }, { n: '2' }]
  const value = (row, key) => row[key]
  assert.deepEqual(sortDbRows(rows, 'n', 'asc', value).map(row => row.n), [2, '2', '10', null, ''])
  assert.deepEqual(sortDbRows(rows, 'n', 'desc', value).map(row => row.n), ['10', 2, '2', null, ''])
  assert.equal(compareDbValues('分区', '副本') < 0, '分区'.localeCompare('副本', 'zh') < 0)
  const original = [{ n: 1 }]
  assert.notEqual(sortDbRows(original, undefined, undefined, value), original)
  assert.deepEqual(original, [{ n: 1 }])
})

test('active row class is only the grid selection marker', () => {
  assert.equal(dbRowClass(true), 'is-active')
  assert.equal(dbRowClass(false), '')
})

test('search tree uses the connection branch, and the query grid and Redis toolbar stay specialized', () => {
  const tree = read('../src/client/workspace/tree/search-tree.tsx')
  const grid = read('../src/client/data-grid.tsx')
  const toolbar = read('../src/client/redis/key-toolbar.tsx')
  const overview = read('../src/client/kafka/overview.tsx')
  const describe = read('../src/client/kafka/describe-table.tsx')
  const group = read('../src/client/kafka/group-detail.tsx')
  const css = read('../src/client/style.css')
  const results = read('../src/client/kafka/results.tsx')
  assert.match(tree, /TreeBranch/)
  assert.match(tree, /db-object-head/)
  assert.match(tree, /button type="button" className="db-tree-label"/)
  assert.match(tree, /db-search-tree-body db-conn-tree/)
  assert.match(grid, /onEditStart/)
  assert.match(grid, /onEditCommit/)
  assert.match(toolbar, /TTL/)
  assert.match(toolbar, /aria-label="设置 TTL"/)
  assert.match(overview, /title=\{paneTitle\}/)
  assert.match(overview, /className="db-btn"/)
  assert.doesNotMatch(overview, /db-sql-toolbar-btn/)
  assert.match(describe, /DbTable/)
  assert.match(describe, /heading = true/)
  assert.match(group, /DbTable/)
  assert.match(group, /heading = true/)
  assert.doesNotMatch(results, /heading=\{false\}/)
  assert.match(css, /\.db-workbench \.db-btn,\.db-workbench \.db-redis-btn\{/)
  assert.match(css, /\.db-workbench \.db-sql-toolbar \.db-sql-toolbar-btn\{height:30px/)
})

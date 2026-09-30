import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { filterRows, nextPage, presentEncoding, rejectStringSave, rowSubmittable, tableColumns, viewKind } from '../src/client/redis/key-model.ts'

test('key viewers pick one content area and column set', () => {
  assert.equal(viewKind('string', 'text'), 'string')
  assert.equal(viewKind('string', 'bit'), 'bitmap')
  assert.equal(viewKind('json', 'text'), 'string')
  assert.equal(viewKind('zset', 'text'), 'table')
  assert.equal(viewKind('stream', 'text'), 'stream')
  assert.equal(viewKind('hyperloglog', 'text'), 'card')
  assert.equal(viewKind('bloom', 'text'), 'card')
  assert.deepEqual(tableColumns('hash').map(column => column.label), ['Key', 'Value', 'TTL'])
  assert.deepEqual(tableColumns('list').map(column => column.key), ['value'])
  assert.deepEqual(tableColumns('set').map(column => column.key), ['member'])
  assert.deepEqual(tableColumns('zset').map(column => column.key), ['score', 'member'])
  assert.deepEqual(tableColumns('geo').map(column => column.key), ['member', 'lon', 'lat'])
  assert.deepEqual(tableColumns('timeseries').map(column => column.key), ['time', 'value'])
  assert.deepEqual(tableColumns('stream').map(column => column.key), ['id', 'fields'])
  assert.equal(nextPage('list', '0', 0).offset, 100)
  assert.equal(nextPage('hash', '12', 0).cursor, '12')
})

test('string encodings only change the displayed text', () => {
  const json = presentEncoding('json', '{"a":1}')
  assert.equal(json.editable, true)
  assert.equal(json.invalidJson, false)
  assert.match(json.text, /\n/)
  const hex = presentEncoding('hex', 'A')
  assert.equal(hex.editable, false)
  assert.equal(hex.text, '41')
  const binary = presentEncoding('binary', 'A')
  assert.equal(binary.editable, false)
  assert.match(binary.text, /长度 1 字节/)
  assert.equal(rejectStringSave('text', 'hello'), undefined)
  assert.match(rejectStringSave('json', '{'), /JSON 无效/)
  assert.match(rejectStringSave('hex', '41'), /只读/)
})

test('member search filters loaded rows and empty keys are not submitted', () => {
  const columns = tableColumns('set')
  const rows = [{ id: '1', cells: { member: 'Apple' } }, { id: '2', cells: { member: 'berry' } }]
  assert.deepEqual(filterRows(rows, columns, 'app').map(row => row.id), ['1'])
  assert.equal(filterRows(rows, columns, '   ').length, 2)
  assert.equal(rowSubmittable('hash', { field: '  ', value: 'a' }), false)
  assert.equal(rowSubmittable('hash', { field: 'a', value: '' }), true)
  assert.equal(rowSubmittable('zset', { member: 'a', score: 'no' }), false)
  assert.equal(rowSubmittable('zset', { member: 'a', score: '0' }), true)
  assert.equal(rowSubmittable('bitmap', { offset: '3', bit: '2' }), false)
  assert.equal(rowSubmittable('stream', { field: '' }), false)
})

test('row edit keeps the cell in document flow and turns the pencil into a check', () => {
  const table = readFileSync(new URL('../src/client/redis/key-table.tsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8')
  assert.match(table, /editing === row\.id \? <Check/)
  assert.match(table, /className="db-redis-key-cell"/)
  assert.match(table, /className="db-redis-key-editor"/)
  assert.match(css, /input\.db-redis-key-editor[\s\S]*position:absolute;inset:0/)
})

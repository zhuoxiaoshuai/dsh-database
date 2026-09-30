import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatFetchedValue,
  isBinaryPlaceholder as isHostBinaryPlaceholder,
} from '../src/host/cell-value.mjs'
import { formatDetailValue, formatGridCell, formatPreview, isBinaryPlaceholder, isLongCell, looksLikeJson } from '../src/shared/cell-value.ts'

test('host and typed shared entry points use one cell-value runtime', () => {
  assert.equal(isBinaryPlaceholder, isHostBinaryPlaceholder)
})

test('fetched values keep NULL, empty string and binary placeholders distinct', () => {
  assert.equal(formatFetchedValue(null, 'mysql'), null)
  assert.equal(formatFetchedValue('', 'mysql'), '')
  assert.equal(formatFetchedValue(Buffer.from('abcd'), 'mysql'), '[BLOB 4 bytes]')
  assert.equal(formatFetchedValue(new Uint8Array(128), 'mysql'), '[BLOB 128 bytes]')
  assert.equal(formatFetchedValue('plain', 'mysql'), 'plain')
  assert.equal(isBinaryPlaceholder('[BLOB 128 bytes]'), true)
  assert.equal(isBinaryPlaceholder(''), false)
  assert.equal(isBinaryPlaceholder(null), false)
  assert.equal(formatPreview(null), 'NULL')
  assert.equal(formatPreview(''), '""')
  assert.equal(formatPreview('[BLOB 128 bytes]'), '[BLOB 128 bytes]')
})

test('grid cells stay single-line summaries while detail pretty-prints JSON', () => {
  const json = '{"userId":10001,"orderId":"A20260918001","status":"SUCCESS","request":{"xxx":"very long payload"}}'
  assert.equal(looksLikeJson(json), true)
  assert.equal(isLongCell(json), true)
  const grid = formatGridCell(json)
  assert.equal(grid.includes('\n'), false)
  assert.ok(grid.endsWith('…'))
  assert.match(grid, /userId/)
  const detail = formatDetailValue(json)
  assert.match(detail, /\n/)
  assert.match(detail, /"userId": 10001/)
  assert.equal(formatDetailValue('not-json {'), 'not-json {')
  assert.equal(formatGridCell(null), 'NULL')
  assert.equal(formatGridCell(''), '""')
  assert.equal(formatGridCell('[BLOB 24 bytes]'), '[BLOB 24 bytes]')
  assert.equal(formatDetailValue(null), 'NULL')
  assert.equal(formatDetailValue(''), '""')
  assert.equal(isLongCell('short'), false)
  assert.equal(isLongCell('line1\nline2'), true)
})

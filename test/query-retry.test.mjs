import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { shouldRetryReadonlySelect } from '../src/host/query-pool.mjs'

test('shouldRetryReadonlySelect retries connection-loss and not timeout, cancel, or SQL errors', () => {
  assert.equal(shouldRetryReadonlySelect(Object.assign(new Error('lost'), { code: 'PROTOCOL_CONNECTION_LOST' })), true)
  assert.equal(shouldRetryReadonlySelect(new Error('ECONNRESET')), true)
  assert.equal(shouldRetryReadonlySelect(new Error('Connection lost')), true)
  assert.equal(shouldRetryReadonlySelect(Object.assign(new Error('PROTOCOL_SEQUENCE_TIMEOUT'), { code: 'PROTOCOL_SEQUENCE_TIMEOUT' })), false)
  assert.equal(shouldRetryReadonlySelect(new Error('query timed out')), false)
  assert.equal(shouldRetryReadonlySelect(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })), false)
  assert.equal(shouldRetryReadonlySelect(Object.assign(new Error('读取已取消。'), { cancelled: true })), false)
  assert.equal(shouldRetryReadonlySelect(new Error('lost'), { aborted: true }), false)
  assert.equal(shouldRetryReadonlySelect(new Error('lost'), { cancelled: true }), false)
  assert.equal(shouldRetryReadonlySelect(new Error('无权读取此库。')), false)
  assert.equal(shouldRetryReadonlySelect(new Error('syntax error')), false)
})

test('Oracle select fetches rows in batches instead of one at a time', () => {
  const adapter = readFileSync(new URL('../src/host/data-sources/oracle/driver.mjs', import.meta.url), 'utf8')
  assert.ok(adapter.includes('getRows(Math.min(limit, 50))'))
  assert.equal(adapter.includes('getRows(1)'), false)
})

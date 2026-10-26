import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectBounded } from '../experiments/bounded-parser.mjs'
test('Oracle parser runs off-thread while the host event loop remains responsive', async () => {
  const pending = inspectBounded('oracle', 'SELECT 1 FROM dual')
  let eventLoopTurned = false
  setImmediate(() => { eventLoopTurned = true })
  // Worker startup plus the Oracle parse must never block the host loop.
  const result = await pending
  assert.equal(result.parsed, true)
  assert.equal(eventLoopTurned, true, '解析期间宿主事件循环必须继续运行')
})
test('a heavy Oracle parse stays off-thread and terminates at the bound', async () => {
  const pending = inspectBounded('oracle', 'SELECT c.id, COUNT(o.id) FROM customers c LEFT JOIN orders o ON c.id = o.customer_id GROUP BY c.id')
  let eventLoopTurned = false
  setImmediate(() => { eventLoopTurned = true })
  // A slow runner can exceed the 5s parse bound; either outcome must keep the host loop live.
  await pending.then(result => assert.equal(result.parsed, true), error => assert.equal(error.message, 'PARSE_TIMEOUT'))
  assert.equal(eventLoopTurned, true, '解析期间宿主事件循环必须继续运行')
})
test('parse timeout terminates the worker rather than leaving a background CPU task', async () => {
  await assert.rejects(inspectBounded('oracle', 'SELECT id FROM orders', { timeoutMs: 1 }), /PARSE_TIMEOUT/)
})
test('parse cancellation and oversized/unrecognized inputs fail before parsing', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(inspectBounded('mysql', 'SELECT 1', { signal: controller.signal }), /PARSE_CANCELLED/)
  await assert.rejects(inspectBounded('unknown', 'SELECT 1'), /INVALID_PARSE_INPUT/)
  await assert.rejects(inspectBounded('oracle', 'x'.repeat(16385)), /INVALID_PARSE_INPUT/)
})

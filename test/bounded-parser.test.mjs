import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectBounded } from '../experiments/bounded-parser.mjs'
test('Oracle parser runs off-thread while the host event loop remains responsive', async () => {
  let ticks = 0
  const timer = setInterval(() => ticks++, 10)
  try {
    const result = await inspectBounded('oracle', 'SELECT c.id, COUNT(o.id) FROM customers c LEFT JOIN orders o ON c.id = o.customer_id GROUP BY c.id')
    assert.equal(result.parsed, true); assert.ok(ticks > 3, `host timer ticked ${ticks} times`)
  } finally { clearInterval(timer) }
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

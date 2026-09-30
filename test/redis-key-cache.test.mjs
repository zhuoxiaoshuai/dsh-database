import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeCachedKeys, removeCachedKey } from '../src/client/redis/key-cache.ts'

test('scanned Redis keys survive a partial scan and visual edits without inventing binary candidates', () => {
  const first = mergeCachedKeys([], ['sample:key', 'two words', 'bad\ufffdkey'])
  assert.deepEqual(first, ['sample:key', 'two words'])
  const partial = mergeCachedKeys(first, ['sample:key', 'other:key'])
  assert.deepEqual(partial, ['sample:key', 'two words', 'other:key'])
  assert.deepEqual(removeCachedKey(partial, 'sample:key'), ['two words', 'other:key'])
  assert.deepEqual(mergeCachedKeys([], partial), partial, 'new connection starts with an empty cache')
})

test('Redis key hint cache remains bounded while a scan continues', () => {
  const many = Array.from({ length: 5100 }, (_, index) => `key:${index}`)
  const result = mergeCachedKeys([], many)
  assert.equal(result.length, 5000)
  assert.deepEqual(mergeCachedKeys(result, ['new:key']), result)
})

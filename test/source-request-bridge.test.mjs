import test from 'node:test'
import assert from 'node:assert/strict'
import { connectionBridge } from '../src/client/connection-bridge.ts'

test('source request bridge binds action to saved connection identity and generation', async () => {
  const calls = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  try {
    const bridge = connectionBridge('conversation 1', { mode: 'host', connections: [], tables: () => [], execute: async () => ({}) })
    const connection = { id: 'connection-1', generation: 'generation-2', dialect: 'redis', database: '0', live: true }
    assert.deepEqual(await bridge.sourceRequest(connection, 'redis-scan', { cursor: '0' }), { ok: true })
    assert.deepEqual(await bridge.redis(connection, 'redis-key', { key: 'a' }), { ok: true })
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0].body, { action: 'redis-scan', id: 'connection-1', generation: 'generation-2', input: { cursor: '0' } })
    assert.deepEqual(calls[1].body, { action: 'redis-key', id: 'connection-1', generation: 'generation-2', input: { key: 'a' } })
    assert.match(calls[0].url, /conversationId=conversation%201/)
    assert.equal(calls[0].options.credentials, 'same-origin')
  } finally { globalThis.fetch = previousFetch }
})

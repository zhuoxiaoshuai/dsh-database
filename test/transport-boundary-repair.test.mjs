import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { connectionBridge } from '../src/client/connection-bridge.ts'
import { createSqlBatch, runSqlBatch } from '../src/shared/sql-batch.ts'

const connection = { id: 'c', generation: 'g', dialect: 'mysql', database: 'original', live: true }
const base = { mode: 'host', connections: [], tables: () => [], execute: async () => ({}) }
const bridge = () => connectionBridge('session', base)
const run = (client, steps = createSqlBatch(['INSERT INTO demo VALUES (1)']), signal = new AbortController().signal) => runSqlBatch({ steps, signal, execute: (sql, signal) => client.executeManual(connection, sql, signal) })

test('actual HTTP consumed write with dropped response is unknown and cannot send twice', async () => {
  let sends = 0
  const server = http.createServer((request) => {
    request.resume()
    request.on('end', () => { sends++; request.socket.destroy() })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const nativeFetch = globalThis.fetch
  globalThis.fetch = (path, options) => nativeFetch(`http://127.0.0.1:${server.address().port}${path}`, options)
  try {
    const result = await run(bridge())
    assert.equal(sends, 1); assert.equal(result[0].status, 'unknown')
    await assert.rejects(run(bridge(), result), /不能重复提交/)
    // A progress reset cannot erase an already observed uncertain write.
    await assert.rejects(run(bridge(), result.map(step => ({ ...step, status: 'pending' }))), /不能重复提交/)
    assert.equal(sends, 1)
  } finally { globalThis.fetch = nativeFetch; await new Promise(resolve => server.close(resolve)) }
})

test('pre-fetch cancellation confirms zero requests', async () => {
  const nativeFetch = globalThis.fetch; let sends = 0
  globalThis.fetch = async () => { sends++; throw new Error('should never run') }
  const controller = new AbortController(); controller.abort()
  try {
    await assert.rejects(bridge().executeManual(connection, 'INSERT 1', controller.signal), error => error.effect === 'none' && error.requestPhase === 'before-fetch' && !error.trustedReceipt)
    assert.equal(sends, 0)
  } finally { globalThis.fetch = nativeFetch }
})

for (const [name, response] of [
  ['truncated JSON', () => new Response('{"rows":', { status: 200 })],
  ['invalid successful JSON', () => new Response('{}', { status: 200 })],
  ['untrusted HTTP error', () => new Response('{"error":"gateway failure"}', { status: 502 })],
]) test(name + ' cannot imply rollback or allow replay', async () => {
  const nativeFetch = globalThis.fetch; let sends = 0
  globalThis.fetch = async () => { sends++; return response() }
  try {
    const result = await run(bridge(), createSqlBatch(['INSERT 1', 'UPDATE demo SET n=2']))
    assert.deepEqual(result.map(step => step.status), ['unknown', 'unknown'])
    await assert.rejects(run(bridge(), result), /不能重复提交/)
    assert.equal(sends, 1)
  } finally { globalThis.fetch = nativeFetch }
})

test('cancel after fetch was called cannot imply no dispatch', async () => {
  const nativeFetch = globalThis.fetch; let sends = 0
  const controller = new AbortController()
  globalThis.fetch = async () => { sends++; controller.abort(); throw new DOMException('aborted', 'AbortError') }
  try { const result = await run(bridge(), undefined, controller.signal); assert.equal(result[0].status, 'unknown'); assert.equal(sends, 1) }
  finally { globalThis.fetch = nativeFetch }
})

test('credible rejection is retryable, missing steps preserve confirmed success and uncertain remainder', async () => {
  const nativeFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'denied before dispatch', effect: 'none', phase: 'check' }), { status: 400 })
    assert.equal((await run(bridge()))[0].status, 'failed')
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'database rejected', effect: 'none', phase: 'execute' }), { status: 400 })
    assert.equal((await run(bridge()))[0].status, 'failed')
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'receipt lost', effect: 'unknown', phase: 'receipt', steps: [{ index: 0, sql: 'INSERT 1', status: 'succeeded', affectedRows: 1 }] }), { status: 400 })
    const result = await run(bridge(), createSqlBatch(['INSERT 1', 'INSERT 2', 'INSERT 3']))
    assert.deepEqual(result.map(step => step.status), ['ok', 'unknown', 'unknown'])
    assert.equal(result[0].result.affectedRows, 1)
  } finally { globalThis.fetch = nativeFetch }
})

test('malformed step facts do not authenticate a response', async () => {
  const nativeFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'pretend rejection', effect: 'none', phase: 'check', steps: [{ index: 0, sql: 'INSERT 1', status: 'made-up' }] }), { status: 400 })
  try { assert.equal((await run(bridge()))[0].status, 'unknown') }
  finally { globalThis.fetch = nativeFetch }
})

test('nested live identity survives credible HTTP failure', async () => {
  const nativeFetch = globalThis.fetch
  const identity = { conversationId: 'session', connectionId: 'c', generation: 'g', sourceId: 'mysql', context: { schema: 'original' }, queryRevision: 3, documentText: 'INSERT 1', executedSql: 'INSERT 1', initiator: 'user' }
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'rejected', effect: 'none', phase: 'execute', identity }), { status: 400 })
  try { await assert.rejects(bridge().executeManual(connection, 'INSERT 1', new AbortController().signal), error => { assert.deepEqual(error.identity, identity); return error.trustedReceipt }) }
  finally { globalThis.fetch = nativeFetch }
})

test('source lifecycle marker without payload is not a successful execution response', async () => {
  const nativeFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ executionId: 'e', executionStatus: 'succeeded' }))
  try { await assert.rejects(bridge().executions('execution-document-run', { id: 'c', generation: 'g', revision: 1 }), error => error.effect === 'unknown' && /缺少有效执行回执/.test(error.message)) }
  finally { globalThis.fetch = nativeFetch }
})

test('legacy shared-query-explain uses the same untrusted HTTP receipt boundary', async () => {
  const nativeFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'proxy failed' }), { status: 502 })
  try { await assert.rejects(bridge().executions('shared-query-explain', { id: 'c', generation: 'g', revision: 1 }), error => error.effect === 'unknown' && error.requestPhase === 'response' && error.trustedReceipt === false) }
  finally { globalThis.fetch = nativeFetch }
})

test('legacy expanded successful writes keep replay prohibition after status reset', async () => {
  const empty = { columns: [], rows: [], elapsedMs: 0, truncated: false }
  const result = await runSqlBatch({ steps: createSqlBatch(['INSERT 1; INSERT 2']), signal: new AbortController().signal,
    execute: async () => ({ ...empty, batch: [{ ...empty, sql: 'INSERT 1' }, { ...empty, sql: 'INSERT 2' }] }) })
  await assert.rejects(runSqlBatch({ steps: result.map(step => ({ ...step, status: 'pending' })), signal: new AbortController().signal, execute: async () => { throw new Error('must not send') } }), /不能重复提交/)
})

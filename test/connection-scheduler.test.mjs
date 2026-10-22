import test from 'node:test'
import assert from 'node:assert/strict'
import { ConnectionScheduler } from '../src/host/connection-scheduler.ts'
import { connectionFailure, recoveryDelay } from '../src/host/connection-failure.mjs'

test('global query reservations are atomic and preserve two manual slots', async () => {
  const scheduler = new ConnectionScheduler(3, 16, 2, 14)
  const permits = await Promise.all(Array.from({length:14}, (_, i) => scheduler.acquire(String(i), 'background')))
  let started = false
  const waiting = scheduler.acquire('ai-waiting', 'background').then(p => {started = true; return p})
  const manual = await Promise.all([scheduler.acquire('manual-a'), scheduler.acquire('manual-b')])
  await Promise.resolve()
  assert.equal(started, false)
  manual[0].release()
  await Promise.resolve()
  assert.equal(started, false)
  permits[0].release(); permits[1].release()
  ;(await waiting).release()
  for (const p of [...permits, ...manual]) p.release()
  scheduler.close()
})

test('connection opening reserves two slots for human work', async () => {
  const scheduler = new ConnectionScheduler(1, 6, 1, 4)
  const recoveries = await Promise.all(Array.from({length:4}, (_, i) => scheduler.acquire(String(i), 'background')))
  let fifthStarted = false
  const fifth = scheduler.acquire('fifth', 'background').then(p => {fifthStarted = true; return p})
  const manual = await Promise.all([scheduler.acquire('new-login'), scheduler.acquire('test-login')])
  assert.equal(fifthStarted, false)
  recoveries.forEach(p => p.release())
  ;(await fifth).release()
  manual.forEach(p => p.release())
  scheduler.close()
})

test('queued reads rotate connections and cancellation releases no occupied slot', async () => {
  const scheduler = new ConnectionScheduler(1, 1, 1, 1)
  const first = await scheduler.acquire('a')
  const order = []
  const a = scheduler.acquire('a').then(p => {order.push('a'); return p})
  const b = scheduler.acquire('b').then(p => {order.push('b'); return p})
  const controller = new AbortController()
  const cancelled = scheduler.acquire('c', 'manual', controller.signal)
  controller.abort()
  await assert.rejects(cancelled, /取消/)
  first.release()
  ;(await b).release()
  ;(await a).release()
  assert.deepEqual(order, ['b','a'])
  assert.equal(scheduler.active('c'), 0)
  scheduler.close()
})

test('recovery backoff stays at sixty seconds and jitter is bounded', () => {
  const expected = [500,1000,2000,5000,15000,30000,60000,60000,60000]
  assert.deepEqual(expected.map((_, i) => recoveryDelay(i, () => .5)), expected)
  expected.forEach((delay, i) => {assert.equal(recoveryDelay(i, () => 0), delay * .8); assert.equal(recoveryDelay(i, () => 1), delay * 1.2)})
})

test('structured transport failures do not conflate object ACLs with authentication', () => {
  assert.equal(connectionFailure({name:'KafkaJSTopicAuthorizationFailed'}), 'permission')
  assert.equal(connectionFailure({code:'authentication'}), 'authentication')
  assert.equal(connectionFailure({code:'ECONNRESET', category:'database'}), 'network')
  assert.equal(connectionFailure({code:'CERT_HAS_EXPIRED'}), 'configuration')
  assert.equal(connectionFailure({code:'ORA-00942',message:'object does not exist'}), 'operation')
  assert.equal(connectionFailure({name:'KafkaJSNumberOfRetriesExceeded',cause:{name:'KafkaJSConnectionError'}}), 'network')
  assert.equal(connectionFailure({code:'remote',message:'Nacos 请求失败（HTTP 503）。'}), 'network')
})

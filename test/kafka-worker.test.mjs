import test from 'node:test'
import assert from 'node:assert/strict'
import { peekKafkaPartition } from '../src/host/data-sources/kafka/driver.mjs'

test('Kafka PEEK seeks before collecting messages and never commits a group offset', async () => {
  let onMessage, seeked = false, stopped = 0, disconnected = 0, committed = 0
  const consumer = {
    async connect() {}, async subscribe() {},
    async run({ autoCommit, eachMessage }) { assert.equal(autoCommit, false); onMessage = eachMessage },
    seek({ offset }) {
      assert.equal(offset, '0'); seeked = true
      queueMicrotask(async () => {
        await onMessage({ topic: 'demo', partition: 0, message: { offset: '0', timestamp: '1', key: null, value: Buffer.from('one'), headers: {} } })
        await onMessage({ topic: 'demo', partition: 0, message: { offset: '1', timestamp: '2', key: Buffer.alloc(0), value: Buffer.from('two'), headers: {} } })
      })
    },
    async stop() { stopped += 1 }, async disconnect() { disconnected += 1 },
    async commitOffsets() { committed += 1 },
    async commitOffsetsIfNecessary() { committed += 1 },
  }
  const runtime = { admin: { async fetchTopicOffsets() { return [{ partition: 0, low: '0', high: '2' }] } },
    kafka: { consumer: () => consumer } }
  const result = await peekKafkaPartition(runtime, { kind: 'peek', topic: 'demo', partition: 0, from: 'beginning', limit: 20 })
  assert.equal(seeked, true)
  assert.equal(result.complete, true)
  assert.deepEqual(result.messages.map(item => item.value.text), ['one', 'two'])
  assert.deepEqual([stopped, disconnected, committed], [1, 1, 0])
})

test('Kafka PEEK rejects an already cancelled request before accessing the broker', async () => {
  const controller = new AbortController(); controller.abort()
  let accessed = false
  await assert.rejects(peekKafkaPartition({ admin: { async fetchTopicOffsets() { accessed = true } } },
    { kind: 'peek', topic: 'demo', partition: 0, from: 'beginning', limit: 20 }, controller.signal), /取消/)
  assert.equal(accessed, false)
})

test('Kafka PEEK deadline also bounds a stalled consumer connect', async () => {
  let stopped = 0, disconnected = 0
  const runtime = { admin: { async fetchTopicOffsets() { return [{ partition: 0, low: '0', high: '1' }] } },
    kafka: { consumer: () => ({ connect: () => new Promise(() => {}),
      async stop() { stopped += 1 }, async disconnect() { disconnected += 1 } }) } }
  const begun = Date.now()
  await assert.rejects(peekKafkaPartition(runtime, { kind: 'peek', topic: 'demo', partition: 0, from: 'beginning', limit: 1 }, undefined, 15),
    error => error.recycleWorker === true)
  assert.ok(Date.now() - begun < 1000)
  assert.deepEqual([stopped, disconnected], [1, 1])
})

test('Kafka PEEK deadline includes stalled metadata lookup', async () => {
  let consumerCreated = false
  const begun = Date.now()
  await assert.rejects(peekKafkaPartition({ admin: { fetchTopicOffsets: () => new Promise(() => {}) },
    kafka: { consumer() { consumerCreated = true } } },
  { kind: 'peek', topic: 'demo', partition: 0, from: 'beginning', limit: 1 }, undefined, 15), /截止时间/)
  assert.equal(consumerCreated, false)
  assert.ok(Date.now() - begun < 500)
})

test('Kafka PEEK disables consumer restart and retains bounded partial data after a crash', async () => {
  let onMessage, onCrash, restart, disconnected = 0
  const consumer = {
    events: { CRASH: 'crash' },
    on(_event, callback) { onCrash = callback; return () => { onCrash = undefined } },
    async connect() {}, async subscribe() {},
    async run({ eachMessage, autoCommit }) { assert.equal(autoCommit, false); onMessage = eachMessage },
    seek() {
      queueMicrotask(async () => {
        await onMessage({ topic: 'demo', partition: 0, message: { offset: '0', value: Buffer.from('one') } })
        onCrash({ payload: { error: new Error('disconnected') } })
      })
    },
    async stop() {}, async disconnect() { disconnected += 1 },
  }
  const runtime = { admin: { async fetchTopicOffsets() { return [{ partition: 0, low: '0', high: '5' }] } },
    kafka: { consumer(options) { restart = options.retry.restartOnFailure; return consumer } } }
  const result = await peekKafkaPartition(runtime, { kind: 'peek', topic: 'demo', partition: 0, from: 'beginning', limit: 20 })
  assert.equal(await restart(), false)
  assert.equal(result.reason, 'error')
  assert.equal(result.complete, false)
  assert.deepEqual(result.messages.map(item => item.value.text), ['one'])
  assert.equal(disconnected, 1)
  assert.equal(onCrash, undefined)
})

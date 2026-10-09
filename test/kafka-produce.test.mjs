import test from 'node:test'
import assert from 'node:assert/strict'
import { produceKafkaMessage } from '../src/host/data-sources/kafka/driver.mjs'
import { kafkaExecution } from '../src/host/data-sources/kafka/execution.ts'
import { kafkaKnowledgePolicy } from '../src/host/data-sources/kafka/knowledge-policy.ts'

const command = 'PRODUCE {"topic":"demo","key":"case-1","value":"hello","partition":0,"headers":{"trace-id":"t1"}}'

test('Kafka publish is one acknowledged send to an existing topic, without payload in the receipt', async () => {
  const calls = []
  const runtime = {
    admin: { async fetchTopicMetadata(input) { calls.push(['metadata', input]); return { topics: [{ name: 'demo', partitions: [{ partitionId: 0 }] }] } } },
    kafka: { producer(options) { calls.push(['producer', options]); return {
      async connect() { calls.push(['connect']) },
      async send(input) { calls.push(['send', input]); return [{ topicName: 'demo', partition: 0, errorCode: 0, baseOffset: '42' }] },
      async disconnect() { calls.push(['disconnect']) },
    } } },
  }
  const operation = kafkaExecution.prepareText(command)
  assert.equal(operation.action, 'kafka-produce')
  kafkaExecution.authorize(operation, 'ai', { environment: 'sit' })
  const result = await produceKafkaMessage(runtime, JSON.parse(command.slice(8)))
  assert.deepEqual(result, { kind: 'produce', topic: 'demo', partition: 0, baseOffset: '42', valueBytes: 5, acknowledged: true, elapsedMs: 0 })
  assert.equal(calls[1][1].allowAutoTopicCreation, false)
  assert.equal(calls[1][1].retry.retries, 0)
  assert.equal(calls[3][1].acks, -1)
  assert.deepEqual(calls.map(row => row[0]), ['metadata', 'producer', 'connect', 'send', 'disconnect'])
  assert.ok(!JSON.stringify(result).includes('hello'))
  for (const environment of ['uat', 'pvt']) assert.throws(() => kafkaExecution.authorize(operation, 'ai', { environment }), /SIT/)
  assert.throws(() => kafkaKnowledgePolicy.analyze(command), /不能保存为经验/)
})

test('Kafka publish checks target before sending and treats lost send receipt as unknown', async () => {
  let created = 0
  const absent = { admin: { async fetchTopicMetadata() { return { topics: [] } } }, kafka: { producer() { created++; throw new Error('must not create') } } }
  await assert.rejects(produceKafkaMessage(absent, { topic: 'missing', value: 'x' }), error => error.effect === 'none')
  assert.equal(created, 0)
  const runtime = { admin: { async fetchTopicMetadata() { return { topics: [{ name: 'demo', partitions: [{ partitionId: 0 }] }] } } },
    kafka: { producer() { return { async connect() {}, async send() { throw new Error('lost ack') }, async disconnect() {} } } } }
  await assert.rejects(produceKafkaMessage(runtime, { topic: 'demo', value: 'x' }), error => error.effect === 'unknown')
  const abort = new AbortController(); abort.abort()
  await assert.rejects(produceKafkaMessage(runtime, { topic: 'demo', value: 'x' }, abort.signal), error => error.effect === 'none')
})

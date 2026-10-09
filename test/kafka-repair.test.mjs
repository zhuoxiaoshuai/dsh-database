import test from 'node:test'
import assert from 'node:assert/strict'
import { produceKafkaMessage, produceKafkaBatch, produceKafkaTombstone, createKafkaTopic, setKafkaGroupOffsets, kafkaTimeOffsets } from '../src/host/data-sources/kafka/driver.mjs'
import { emptyExecutionDocument, updateExecutionDocument } from '../src/shared/execution-document.ts'

function producerRuntime(send) {
  return {
    admin: { async fetchTopicMetadata() { return { topics: [{ name: 'dsh-test-demo', partitions: [{ partitionId: 0 }] }] } } },
    kafka: { producer() { return { async connect() {}, send, async disconnect() {} } } },
  }
}

test('binary key, value and repeated headers reach Kafka unchanged', async () => {
  let sent
  const runtime = producerRuntime(async input => { sent = input; return [{ topicName: 'dsh-test-demo', partition: 0, baseOffset: '9', errorCode: 0 }] })
  const result = await produceKafkaMessage(runtime, { kind: 'produce', topic: 'dsh-test-demo', key: { base64: '/w==' },
    value: { base64: 'AAEC' }, headers: { trace: [{ base64: '/wA=' }, 'text'] } })
  assert.deepEqual([...sent.messages[0].key], [255])
  assert.deepEqual([...sent.messages[0].value], [0, 1, 2])
  assert.deepEqual(sent.messages[0].headers.trace.map(part => [...part]), [[255, 0], [...Buffer.from('text')]])
  assert.equal(result.valueBytes, 3)
  assert.ok(!JSON.stringify(result).includes('AAEC'))
})

test('batch stops at first uncertain message and retains earlier acknowledgements', async () => {
  let calls = 0, progress
  const runtime = producerRuntime(async () => {
    calls++
    if (calls === 2) throw new Error('lost ack')
    return [{ topicName: 'dsh-test-demo', partition: 0, baseOffset: '7', errorCode: 0 }]
  })
  const result = await produceKafkaBatch(runtime, { topic: 'dsh-test-demo', messages: [{ value: 'a' }, { value: 'b' }, { value: 'c' }] }, undefined, item => { progress = item })
  assert.equal(calls, 2)
  assert.equal(result.status, 'unknown')
  assert.equal(result.failedIndex, 1)
  assert.equal(result.notSent, 1)
  assert.equal(result.receipts[0].baseOffset, '7')
  assert.equal(progress.receipts.length, 1)
})

test('tombstone sends an actual null value only to a compacted topic', async () => {
  let sent, policy = 'delete'
  const runtime = producerRuntime(async input => { sent = input; return [{ topicName: 'dsh-test-demo', partition: 0, baseOffset: '10', errorCode: 0 }] })
  runtime.admin.describeConfigs = async () => ({ resources: [{ resourceName: 'dsh-test-demo', errorCode: 0,
    configEntries: [{ configName: 'cleanup.policy', configValue: policy, isDefault: false, isSensitive: false }] }] })
  await assert.rejects(produceKafkaTombstone(runtime, { kind: 'tombstone', topic: 'dsh-test-demo', key: 'k' }), error => error.effect === 'none')
  assert.equal(sent, undefined)
  policy = 'compact'
  const receipt = await produceKafkaTombstone(runtime, { kind: 'tombstone', topic: 'dsh-test-demo', key: 'k' })
  assert.equal(sent.messages[0].value, null)
  assert.equal(receipt.kind, 'tombstone')
})

test('topic creation validates before mutating and checks metadata afterwards', async () => {
  const calls = []
  const runtime = { admin: {
    async describeCluster() { return { brokers: [{ nodeId: 1 }] } },
    async createTopics(input) { calls.push(input); return true },
    async fetchTopicMetadata() { return { topics: [{ name: 'dsh-test-demo', partitions: [{ partitionId: 0 }] }] } },
  } }
  const result = await createKafkaTopic(runtime, { topic: 'dsh-test-demo', partitions: 1, replicationFactor: 1, cleanupPolicy: 'compact' })
  assert.deepEqual(calls.map(item => item.validateOnly), [true, undefined])
  assert.equal(result.partitionCount, 1)
  assert.equal(result.acknowledged, true)
})

test('offset mutation rejects changed old position and uses high for no later timestamp', async () => {
  let current = '4', setInput
  const runtime = { admin: {
    async fetchTopicMetadata() { return { topics: [{ name: 'dsh-test-demo', partitions: [{ partitionId: 0 }] }] } },
    async describeGroups() { return { groups: [{ groupId: 'g', state: 'Empty', members: [] }] } },
    async fetchOffsets() { return [{ topic: 'dsh-test-demo', partitions: [{ partition: 0, offset: current }] }] },
    async fetchTopicOffsets() { return [{ partition: 0, low: '0', high: '10' }] },
    async fetchTopicOffsetsByTimestamp() { return [{ partition: 0, offset: '-1' }] },
    async setOffsets(input) { setInput = input; current = input.partitions[0].offset },
  } }
  await assert.rejects(setKafkaGroupOffsets(runtime, { groupId: 'g', topic: 'dsh-test-demo', expected: { 0: '3' }, offsets: { 0: '5' } }), error => error.effect === 'none')
  assert.equal(setInput, undefined)
  const result = await setKafkaGroupOffsets(runtime, { groupId: 'g', topic: 'dsh-test-demo', expected: { 0: '4' }, timestamp: 1760000000000, partitions: [0] })
  assert.deepEqual(setInput.partitions, [{ partition: 0, offset: '10' }])
  assert.deepEqual(result.after, { 0: '10' })
  const positions = await kafkaTimeOffsets(runtime, { topic: 'dsh-test-demo', timestamp: 1760000000000 })
  assert.equal(positions.partitions[0].noLaterMessage, true)
})

test('Kafka document accepts bounded binary drafts without raising other source limits', () => {
  const text = 'x'.repeat(90_000)
  assert.equal(updateExecutionDocument(emptyExecutionDocument('kafka'), text, 'ai').text.length, text.length)
  assert.equal(updateExecutionDocument(emptyExecutionDocument('mysql'), text, 'ai').text.length, 65536)
})

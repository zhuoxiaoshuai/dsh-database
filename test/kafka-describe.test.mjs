import test from 'node:test'
import assert from 'node:assert/strict'
import {
  kafkaIsEmptyWatermark, kafkaMessageTotals, kafkaInternalTopic, kafkaLeaderText, kafkaPeekCommand,
  kafkaReplicaFactor, kafkaReplicasText, kafkaTopicSummary,
} from '../src/client/kafka/describe.ts'

test('Topic 总览标签：内部名、无 Leader、空分区、一致副本因子', () => {
  assert.equal(kafkaInternalTopic('__consumer_offsets'), true)
  assert.equal(kafkaInternalTopic('_consumer_offsets'), false)
  assert.equal(kafkaInternalTopic('orders'), false)
  assert.equal(kafkaLeaderText(-1), '无')
  assert.equal(kafkaLeaderText(undefined), '无')
  assert.equal(kafkaLeaderText(0), '0')
  assert.equal(kafkaIsEmptyWatermark('8', '8'), true)
  assert.equal(kafkaIsEmptyWatermark('0', '12'), false)
  assert.equal(kafkaIsEmptyWatermark(undefined, undefined), false)
  assert.equal(kafkaIsEmptyWatermark('', ''), false)
  assert.equal(kafkaReplicasText([1, 2, 3]), '1, 2, 3')
  assert.equal(kafkaReplicasText([]), '无')
  assert.equal(kafkaReplicaFactor([{ partition: 0, replicas: [1, 2] }, { partition: 1, replicas: [2, 1] }]), 2)
  assert.equal(kafkaReplicaFactor([{ partition: 0, replicas: [1] }, { partition: 1, replicas: [1, 2] }]), undefined)
  assert.equal(kafkaReplicaFactor([{ partition: 0, replicas: [1] }, { partition: 1, replicas: [] }]), undefined)
  assert.equal(kafkaTopicSummary('orders', []), '0 个分区')
  assert.equal(kafkaTopicSummary('__consumer_offsets', [{ partition: 0, replicas: [1, 2] }]), '内部 Topic · 1 个分区 · 副本因子 2 · 点击分区创建有界读取草稿。')
  assert.equal(kafkaTopicSummary('orders', [{ partition: 0, replicas: [1] }], false), '1 个分区 · 副本因子 1')
  assert.equal(kafkaPeekCommand('orders', 3), 'PEEK "orders" PARTITION 3 FROM LATEST LIMIT 20')
})

test('Topic metrics retain large End values and distinguish unknown and empty watermarks', () => {
  assert.deepEqual(kafkaMessageTotals([
    {partition:0,low:'9007199254740993',high:'9007199254740993',replicas:[1,2],isr:[1]},
    {partition:1,low:'0',high:'2',replicas:[1,2],isr:[1,2]},
    {partition:2},
  ]), {total:'9007199254740995',empty:1,isrBehind:1})
  assert.deepEqual(kafkaMessageTotals([{partition:0}]), {total:'-',empty:0,isrBehind:0})
})

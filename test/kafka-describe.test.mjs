import test from 'node:test'
import assert from 'node:assert/strict'
import {
  kafkaHighWatermarkText, kafkaInternalTopic, kafkaLeaderText, kafkaPeekCommand,
  kafkaReplicaFactor, kafkaReplicasText, kafkaTopicSummary,
} from '../src/client/kafka/describe.ts'

test('Topic 总览标签：内部名、无 Leader、空分区、一致副本因子', () => {
  assert.equal(kafkaInternalTopic('__consumer_offsets'), true)
  assert.equal(kafkaInternalTopic('_consumer_offsets'), false)
  assert.equal(kafkaInternalTopic('orders'), false)
  assert.equal(kafkaLeaderText(-1), '无')
  assert.equal(kafkaLeaderText(undefined), '无')
  assert.equal(kafkaLeaderText(0), '0')
  assert.equal(kafkaHighWatermarkText('8', '8'), '8 · 空')
  assert.equal(kafkaHighWatermarkText('0', '12'), '12')
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

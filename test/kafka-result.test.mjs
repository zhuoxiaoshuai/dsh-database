import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeKafkaBytes, encodeKafkaMessage, appendKafkaMessage, kafkaHistorySummary } from '../src/host/data-sources/kafka/result.mjs'

test('Kafka 值区分 null、空字节与二进制', () => {
  assert.deepEqual(encodeKafkaBytes(null), { kind: 'null', length: 0 })
  assert.deepEqual(encodeKafkaBytes(Buffer.alloc(0)), { kind: 'text', length: 0, truncated: false, text: '' })
  assert.deepEqual(encodeKafkaBytes(Buffer.from([0xff, 0x00])), { kind: 'binary', length: 2, truncated: false, base64: '/wA=' })
  assert.equal(encodeKafkaMessage({ offset: '5', headers: { x: Buffer.from('a') } }).headers.x.text, 'a')
  assert.deepEqual(encodeKafkaMessage({ offset: '5', headers: { x: [Buffer.from('a'), Buffer.from('b')] } }).headers.x.map(item => item.text), ['a', 'b'])
})

test('Kafka 结果有总字节界限，历史不保存消息正文', () => {
  const result = { messages: [], bytes: 1024 * 1024 - 8192 }
  assert.equal(appendKafkaMessage(result, { offset: '1', value: Buffer.from('secret') }), false)
  const summary = kafkaHistorySummary({ kind: 'peek', topic: 'orders', partition: 0 }, { messages: [{ value: 'secret' }], complete: true })
  assert.equal(JSON.stringify(summary).includes('secret'), false)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeKafkaBytes, encodeKafkaMessage, appendKafkaMessage, limitKafkaResult, kafkaNamePage, kafkaResultBytes, kafkaFailureHealth } from '../src/host/data-sources/kafka/result.mjs'
import { kafkaExecution } from '../src/host/data-sources/kafka/execution.ts'

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
  const summary = kafkaExecution.prepareText('PEEK "orders" PARTITION 0 FROM BEGINNING').summarize({ messages: [{ value: 'secret' }], complete: true })
  assert.equal(JSON.stringify(summary).includes('secret'), false)
})

test('Kafka metadata is byte bounded and explicitly truncated, list cursors advance only past delivered names', () => {
  const large = { kind: 'group', members: Array.from({ length: 100 }, (_, i) => ({ memberId: String(i), assignment: { big: 'a'.repeat(20000) } })) }
  const bounded = limitKafkaResult(large)
  assert.ok(kafkaResultBytes(bounded) < 1024 * 1024)
  assert.equal(bounded.resultTruncated, true)
  assert.equal(large.members.length, 100)
  const page = kafkaNamePage(Array.from({ length: 250 }, (_, i) => `name-${i}`), '100', 'topics', { kind: 'topics' })
  assert.equal(page.topics.length, 100); assert.equal(page.nextCursor, '200')
  for (const cursor of ['-1', '1.5', '01', '1e2', 'Infinity']) assert.throws(() => kafkaNamePage(['x'], cursor, 'topics'))
  assert.equal(kafkaFailureHealth({ name: 'KafkaJSConnectionError' }), 'degraded')
  assert.equal(kafkaFailureHealth({ name: 'KafkaJSProtocolError', type: 'TOPIC_AUTHORIZATION_FAILED' }), undefined)
})

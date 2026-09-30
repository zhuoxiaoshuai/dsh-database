import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeKafkaConfig, kafkaFingerprint, kafkaWorkerConfig } from '../src/host/data-sources/kafka/connection.mjs'

test('Kafka brokers are bounded, canonical and part of the identity', () => {
  const input = normalizeKafkaConfig({ brokers: ['B.example:9092', 'b.example:9092', '[::1]:9093'], saslMechanism: 'none' })
  assert.deepEqual(input.brokers, ['[::1]:9093', 'b.example:9092'])
  assert.equal(kafkaFingerprint({ ...input, brokers: [...input.brokers].reverse() }), kafkaFingerprint(input))
  assert.throws(() => normalizeKafkaConfig({ brokers: [] }), /Broker/)
  assert.throws(() => normalizeKafkaConfig({ brokers: ['a:0'] }), /Broker/)
  assert.throws(() => normalizeKafkaConfig({ brokers: ['a:9092'], saslMechanism: 'oauth' }), /认证机制/)
})

test('Kafka PLAIN may omit TLS and credentials never enter fingerprint', () => {
  const plaintext = normalizeKafkaConfig({ brokers: ['a:9092'], saslMechanism: 'plain', username: 'u', password: 'secret' })
  assert.equal(plaintext.tls, false)
  const plainWorker = kafkaWorkerConfig(plaintext)
  assert.equal(plainWorker.sasl.mechanism, 'plain')
  assert.equal(plainWorker.ssl, undefined)
  const config = normalizeKafkaConfig({ brokers: ['a:9092'], tls: true, saslMechanism: 'plain', username: 'u', password: 'secret' })
  const changed = { ...config, password: 'different' }
  assert.equal(kafkaFingerprint(config), kafkaFingerprint(changed))
  const worker = kafkaWorkerConfig(config)
  assert.equal(worker.sasl.password, 'secret')
  assert.equal(worker.ssl.rejectUnauthorized, true)
  assert.equal(worker.allowAutoTopicCreation, false)
})

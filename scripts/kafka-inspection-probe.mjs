import assert from 'node:assert/strict'
import { Kafka, logLevel } from 'kafkajs'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { ConnectionService } from '../src/host/connection-service.ts'
import { memoryPasswordProtector } from '../src/host/saved-connections.ts'

if (!process.env.DSH_KAFKA_BROKERS) throw new Error('此验收仅允许 withKafkaFixture 提供的隔离 Broker。')
const brokers = process.env.DSH_KAFKA_BROKERS.split(',')
const marker = `${Date.now()}-${process.pid}`, topic = `dsh_inspection_${marker}`, active = `dsh-inspection-active-${marker}`, old = `dsh-inspection-old-${marker}`
const root = resolve('artifacts/kafka-inspection-live'); mkdirSync(root, { recursive: true })
const service = new ConnectionService(() => true, mkdtempSync(join(root, 'host-')), undefined, memoryPasswordProtector)
const kafka = new Kafka({ clientId: 'dsh-inspection-probe', brokers, logLevel: logLevel.ERROR })
const admin = kafka.admin(), producer = kafka.producer(), consumer = kafka.consumer({ groupId: active, allowAutoTopicCreation: false })
try {
  await admin.connect()
  await admin.createTopics({ topics: [{ topic, numPartitions: 2, replicationFactor: 1 }], waitForLeaders: true })
  await producer.connect()
  await producer.send({ topic, messages: [0, 1].flatMap(partition => [{ partition, value: 'one' }, { partition, value: 'two' }]) })
  await admin.setOffsets({ groupId: old, topic, partitions: [{ partition: 0, offset: '1' }, { partition: 1, offset: '0' }] })
  await consumer.connect(); await consumer.subscribe({ topic, fromBeginning: true })
  await consumer.run({ autoCommit: false, eachMessage: async () => {} })
  const connection = await service.open('inspection', { dialect: 'kafka', name: 'Isolated Kafka inspection', brokers, tls: false, saslMechanism: 'none', environment: 'sit' }, false)
  const read = input => service.explorerRead('inspection', connection.id, connection.generation, input)
  const fresh = await read({ ref: `topic-groups:${encodeURIComponent(topic)}`, refresh: true })
  assert.equal(fresh.complete, true)
  assert.equal(fresh.associations.find(item => item.groupId === active)?.assigned, true)
  assert.equal(fresh.associations.find(item => item.groupId === active)?.committed, false)
  assert.deepEqual(fresh.associations.find(item => item.groupId === old), { groupId: old, assigned: false, committed: true, complete: true })
  const initial = await read({ ref: `gtopic:${encodeURIComponent(active)}:${encodeURIComponent(topic)}`, refresh: true })
  assert.equal(initial.partitions.length, 2)
  assert.ok(initial.partitions.every(row => row.current === null && row.lag === null && row.status === 'uncommitted' && row.host && row.consumerId && row.clientId))
  await consumer.commitOffsets([{ topic, partition: 0, offset: '1' }, { topic, partition: 1, offset: '2' }])
  const summary = await read({ ref: `group-summary:${encodeURIComponent(active)}`, refresh: true })
  assert.equal(summary.totalLag, '1'); assert.equal(summary.topics[0].assignedPartitions, 2)
  const described = await read({ ref: `topic:${encodeURIComponent(topic)}`, refresh: true })
  assert.ok(described.partitions.every(row => row.health === '正常' && row.isr.length === 1))
  const command = await service.executeText('inspection', connection.id, connection.generation, `TOPIC_GROUPS ${JSON.stringify(topic)}`)
  assert.equal(command.executionStatus, 'succeeded'); assert.ok(command.associations.some(item => item.groupId === active))
  await consumer.disconnect()
  const stopped = await read({ ref: `topic-groups:${encodeURIComponent(topic)}`, refresh: true })
  assert.equal(stopped.associations.find(item => item.groupId === active)?.assigned, false)
  assert.equal(stopped.associations.find(item => item.groupId === active)?.committed, true)
  const detail = await read({ ref: `gtopic:${encodeURIComponent(active)}:${encodeURIComponent(topic)}`, refresh: true })
  assert.ok(detail.partitions.every(row => row.host === null && row.consumerId === null))
  const unchanged = await admin.fetchOffsets({ groupId: old, topics: [topic] })
  assert.deepEqual(unchanged[0].partitions.map(row => row.offset), ['1', '0'])
  console.log(JSON.stringify({ inspection: 'PASS', freshAssignment: true, historicalCommit: true, partitionHosts: true, totalLag: summary.totalLag, stoppedAssignment: true, commandLifecycle: true, isolatedGroupOffsetsUnchanged: true }))
} finally {
  await service.dispose()
  await Promise.allSettled([consumer.disconnect(), producer.disconnect()])
  await admin.deleteGroups([active, old]).catch(() => {})
  await admin.deleteTopics({ topics: [topic] }).catch(() => {})
  await admin.disconnect()
}

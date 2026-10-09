import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionService } from '../src/host/connection-service.ts'
import { memoryPasswordProtector } from '../src/host/saved-connections.ts'
import { Kafka, logLevel } from 'kafkajs'

const folder = mkdtempSync(join(tmpdir(), 'dsh-kafka-host-probe-'))
const service = new ConnectionService(() => true, folder, undefined, memoryPasswordProtector)
const input = { name: 'Probe Kafka', dialect: 'kafka', brokers: (process.env.DSH_KAFKA_BROKERS || '127.0.0.1:19092').split(','),
  tls: false, saslMechanism: 'none', username: '', password: '', environment: 'sit', rememberPassword: false }
const fixture = new Kafka({ clientId: 'dsh-host-probe-fixture', brokers: input.brokers, logLevel: logLevel.ERROR })
const admin = fixture.admin(), producer = fixture.producer()
const topic = `dsh_host_probe_${Date.now()}`
const testTopic = `dsh-test-host-${Date.now()}`
try {
  await admin.connect()
  await admin.createTopics({ topics: [{ topic, numPartitions: 1, replicationFactor: 1 }], waitForLeaders: true })
  await producer.connect()
  await producer.send({ topic, messages: [{ value: 'probe-value' }] })
  const tested = await service.open('probe-owner', input, true)
  const connection = await service.open('probe-owner', input, false)
  const snapshot = service.snapshot('probe-owner')
  const saved = readFileSync(join(folder, 'database-workspace.json'), 'utf8')
  if (connection.dialect !== 'kafka' || !connection.generation || snapshot.connections.length !== 1 || saved.includes('caPem')) throw new Error('Kafka 连接保存或脱敏异常。')
  const topics = await service.executeText('probe-owner', connection.id, connection.generation, 'TOPICS')
  const described = await service.executeText('probe-owner', connection.id, connection.generation, `DESCRIBE ${JSON.stringify(topic)}`)
  const peek = await service.executeText('probe-owner', connection.id, connection.generation, `PEEK ${JSON.stringify(topic)} PARTITION 0 FROM BEGINNING LIMIT 1`)
  if (!topics.topics.includes(topic) || described.partitions.length !== 1 || peek.messages[0]?.value.text !== 'probe-value') throw new Error('Kafka Host 执行链异常。')
  const published = await service.executeText('probe-owner', connection.id, connection.generation,
    `PRODUCE ${JSON.stringify({ topic, key: 'dsh-probe-2', value: 'product-produce-probe', partition: 0 })}`)
  if (published.kind !== 'produce' || published.acknowledged !== true || published.partition !== 0) throw new Error('Kafka 发布回执异常。')
  const produced = await service.executeText('probe-owner', connection.id, connection.generation, `PEEK ${JSON.stringify(topic)} PARTITION 0 FROM BEGINNING LIMIT 2`)
  if (produced.messages[1]?.value.text !== 'product-produce-probe' || produced.messages[1]?.key.text !== 'dsh-probe-2') throw new Error('Kafka 发布后回读异常。')
  const created = await service.executeText('probe-owner', connection.id, connection.generation,
    `CREATE_TOPIC ${JSON.stringify({ topic: testTopic, partitions: 1, replicationFactor: 1, cleanupPolicy: 'compact' })}`)
  if (created.kind !== 'create-topic' || created.partitionCount !== 1) throw new Error('Kafka 测试 Topic 创建异常。')
  const config = await service.executeText('probe-owner', connection.id, connection.generation, `TOPIC_CONFIG ${JSON.stringify(testTopic)}`)
  if (!String(config.configs?.['cleanup.policy']?.value).includes('compact')) throw new Error('Kafka Topic 配置回读异常。')
  const binary = await service.executeText('probe-owner', connection.id, connection.generation,
    `PRODUCE ${JSON.stringify({ topic: testTopic, key: { base64: '/w==' }, value: { base64: '/wA=' }, headers: { trace: { base64: 'AAE=' } } })}`)
  const binaryPeek = await service.executeText('probe-owner', connection.id, connection.generation,
    `PEEK ${JSON.stringify(testTopic)} PARTITION 0 FROM OFFSET ${binary.baseOffset} LIMIT 1`)
  if (binaryPeek.messages[0]?.value.base64 !== '/wA=' || binaryPeek.messages[0]?.key.base64 !== '/w==' || binaryPeek.messages[0]?.headers.trace.base64 !== 'AAE=')
    throw new Error(`Kafka 二进制保真回读异常：${JSON.stringify({ receipt: binary, peek: binaryPeek })}`)
  const batch = await service.executeText('probe-owner', connection.id, connection.generation,
    `PRODUCE_BATCH ${JSON.stringify({ topic: testTopic, messages: [{ key: 'batch-1', value: 'one' }, { key: 'batch-2', value: 'two' }] })}`)
  if (batch.status !== 'succeeded' || batch.receipts.length !== 2) throw new Error('Kafka 批量逐条回执异常。')
  const positions = await service.executeText('probe-owner', connection.id, connection.generation,
    `TIME_OFFSETS ${JSON.stringify({ topic: testTopic, timestamp: Date.now() - 60000 })}`)
  if (positions.partitions[0]?.partition !== 0) throw new Error('Kafka 时间定位异常。')
  const scan = await service.executeText('probe-owner', connection.id, connection.generation,
    `SCAN ${JSON.stringify({ topic: testTopic, partitions: [0], offsets: { 0: binary.baseOffset }, key: { base64: '/w==' } })}`)
  if (scan.messages[0]?.value.base64 !== '/wA=') throw new Error('Kafka 跨分区扫描异常。')
  const tombstone = await service.executeText('probe-owner', connection.id, connection.generation,
    `TOMBSTONE ${JSON.stringify({ topic: testTopic, key: { base64: '/w==' } })}`)
  if (tombstone.kind !== 'tombstone' || !tombstone.acknowledged) throw new Error('Kafka 墓碑回执异常。')
  const groupId = `dsh-host-probe-group-${Date.now()}`
  const consumer = fixture.consumer({ groupId })
  await consumer.connect()
  await consumer.subscribe({ topic: testTopic, fromBeginning: false })
  await consumer.run({ autoCommit: false, eachMessage: async () => {} })
  await new Promise(resolve => setTimeout(resolve, 500))
  await consumer.disconnect()
  const shifted = await service.executeText('probe-owner', connection.id, connection.generation,
    `SET_GROUP_OFFSETS ${JSON.stringify({ groupId, topic: testTopic, expected: { 0: null }, offsets: { 0: '0' } })}`)
  if (shifted.after?.['0'] !== '0') throw new Error('Kafka 位点调整回读异常。')
  const page = await service.explorerList('probe-owner', connection.id, connection.generation, { search: topic })
  if (!page.nodes.some(node => node.title === topic)) throw new Error('Kafka Topic 总览异常。')
  const ref = page.nodes.find(node => node.title === topic).ref
  const details = await service.explorerRead('probe-owner', connection.id, connection.generation, { ref })
  if (details.partitions?.[0]?.partition !== 0) throw new Error('Kafka 分区总览异常。')
  const old = service.getExecutionDocument('probe-owner', connection.id, connection.generation)
  const draft = service.updateExecutionDocument('probe-owner', connection.id, `DESCRIBE ${JSON.stringify(topic)}`, 'user', old.revision, connection.generation)
  const aiResult = await service.runExecutionDocument('probe-owner', connection.id, connection.generation, draft.revision)
  if (aiResult.kind !== 'describe') throw new Error('Kafka 共编执行异常。')
  const knowledge = service.handleKnowledge('probe-owner', { action: 'knowledge-publish', connectionId: connection.id, generation: connection.generation,
    text: `DESCRIBE ${JSON.stringify(topic)}`, title: 'Describe probe' })
  if (knowledge.sourceId !== 'kafka') throw new Error('Kafka 经验保存异常。')
  let rejected = false
  try { await service.update('probe-owner', connection.id, { ...input, brokers: ['127.0.0.1:1'] }) }
  catch { rejected = true }
  if (!rejected || !service.list('probe-owner').some(item => item.id === connection.id && item.generation === connection.generation && item.live)) {
    throw new Error('Kafka 编辑失败未保留原连接。')
  }
  console.log(JSON.stringify({ tested, connectionId: connection.id, generation: connection.generation, persisted: true,
    topics: true, describe: true, peek: true, produce: true, binary: true, batch: true, tombstone: true, createTopic: true,
    timeOffsets: true, scan: true, groupOffsets: true, explorer: true, document: true, knowledge: true, failedEditRetained: true }))
} finally {
  await service.dispose()
  await producer.disconnect().catch(() => {})
  await admin.deleteTopics({ topics: [topic] }).catch(() => {})
  await admin.deleteTopics({ topics: [testTopic] }).catch(() => {})
  await admin.disconnect().catch(() => {})
  rmSync(folder, { recursive: true, force: true })
}

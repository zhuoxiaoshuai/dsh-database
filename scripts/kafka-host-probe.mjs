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
    topics: true, describe: true, peek: true, explorer: true, document: true, knowledge: true, failedEditRetained: true }))
} finally {
  await service.dispose()
  await producer.disconnect().catch(() => {})
  await admin.deleteTopics({ topics: [topic] }).catch(() => {})
  await admin.disconnect().catch(() => {})
  rmSync(folder, { recursive: true, force: true })
}

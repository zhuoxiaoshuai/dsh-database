import { Kafka, logLevel } from 'kafkajs'
import { openKafka, closeKafka, peekKafkaPartition } from '../src/host/data-sources/kafka/driver.mjs'

const brokers = (process.env.DSH_KAFKA_BROKERS || '127.0.0.1:19092').split(',')
const kafka = new Kafka({ clientId: 'dsh-kafka-client-probe', brokers, allowAutoTopicCreation: false, logLevel: logLevel.ERROR })
const admin = kafka.admin()
const producer = kafka.producer()
const groupId = `dsh-peek-probe-${process.pid}`
const businessGroupId = `dsh-business-baseline-${process.pid}`
const consumer = kafka.consumer({ groupId, allowAutoTopicCreation: false, maxWaitTimeInMs: 1000 })
const topic = `dsh_probe_${Date.now()}`
const received = []
let timeout
try {
  await admin.connect()
  await admin.createTopics({ topics: [{ topic, numPartitions: 1, replicationFactor: 1 }], waitForLeaders: true })
  await producer.connect()
  await producer.send({ topic, messages: [{ key: 'a', value: 'one' }, { key: 'b', value: 'two' }] })
  await admin.setOffsets({ groupId: businessGroupId, topic, partitions: [{ partition: 0, offset: '1' }] })
  const beforeBusiness = await admin.fetchOffsets({ groupId: businessGroupId, topics: [topic] })
  if (beforeBusiness[0]?.partitions[0]?.offset !== '1') throw new Error('业务组位点基线未建立。')
  const source = await openKafka({ brokers, tls: false, saslMechanism: 'none' })
  let productGroupId
  try {
    const peek = await peekKafkaPartition(source, { kind: 'peek', topic, partition: 0, from: 'beginning', limit: 2 }, undefined, 30000,
      id => { productGroupId = id })
    if (peek.messages.map(item => item.value.text).join(',') !== 'one,two') throw new Error(`产品 PEEK 读取异常：${JSON.stringify(peek)}`)
  } finally { await closeKafka(source) }
  if (!productGroupId) throw new Error('产品 PEEK 未创建临时消费组。')
  const productOffsets = await admin.fetchOffsets({ groupId: productGroupId, topics: [topic] })
  const offsets = await admin.fetchTopicOffsets(topic)
  await consumer.connect()
  await consumer.subscribe({ topic, fromBeginning: false })
  let finish
  const done = new Promise(resolve => { finish = resolve })
  await consumer.run({ autoCommit: false, eachMessage: async ({ message }) => {
    received.push(message.offset)
    if (received.length === 2) finish()
  } })
  consumer.seek({ topic, partition: 0, offset: offsets[0].low })
  await Promise.race([done, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('seek 后未收到消息')), 8000) })])
  const groupOffsets = await admin.fetchOffsets({ groupId, topics: [topic] })
  const afterBusiness = await admin.fetchOffsets({ groupId: businessGroupId, topics: [topic] })
  if (received.join(',') !== '0,1' || productOffsets[0]?.partitions[0]?.offset !== '-1'
    || groupOffsets[0]?.partitions[0]?.offset !== '-1'
    || JSON.stringify(beforeBusiness) !== JSON.stringify(afterBusiness)) throw new Error(`读取或 offset 提交异常：${JSON.stringify({ received, groupOffsets, beforeBusiness, afterBusiness })}`)
  console.log(JSON.stringify({ version: 'kafkajs 2.2.4', topic, received, groupOffsets, productOffsets,
    noCommittedOffset: true, businessOffsetUnchanged: true }))
} finally {
  clearTimeout(timeout)
  await Promise.allSettled([consumer.disconnect(), producer.disconnect()])
  try { await admin.deleteTopics({ topics: [topic] }) } catch { /* disposable broker */ }
  await admin.disconnect()
}

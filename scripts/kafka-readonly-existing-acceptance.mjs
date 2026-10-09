import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Kafka, logLevel } from 'kafkajs'
import { existingKafkaTestSettings, reuseTestEnvironment } from './existing-test-environment.mjs'
import { ConnectionService } from '../src/host/connection-service.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { registerKafkaAiTools } from '../src/host/data-sources/kafka/ai-tools.ts'
import { openKafka, closeKafka, peekKafkaPartition, listKafkaTopics } from '../src/host/data-sources/kafka/driver.mjs'

assert.equal(reuseTestEnvironment(), true, 'This acceptance requires DSH_TEST_EXISTING_ENV=1; it never creates containers')
const settings = await existingKafkaTestSettings()
const prefix = `dsh_ro_${randomUUID().replaceAll('-', '').slice(0, 12)}`
const topic = `${prefix}_main`, empty = `${prefix}_empty`, transactionTopic = `${prefix}_transactions`, businessGroup = `${prefix}_baseline`
const topics = [topic, empty, transactionTopic, ...Array.from({ length: 101 }, (_, i) => `${prefix}_page${String(i).padStart(3, '0')}`)]
const kafka = new Kafka({ ...settings, clientId: `${prefix}_fixture`, allowAutoTopicCreation: false, logLevel: logLevel.NOTHING })
const admin = kafka.admin(), producer = kafka.producer(), productGroups = []
const directory = mkdtempSync(join(tmpdir(), 'dsh-kafka-readonly-'))
const executions = new ExecutionStore(directory)
const service = new ConnectionService(id => id === 'owner', directory, undefined, undefined, executions)
let runtime, transactionProducer
const checks = [], notRun = ['Real Desktop GUI', 'Real model invocation', 'Other TLS/SASL combinations', 'Topic/Group ACL denial: no restricted test account supplied', 'Real log-compaction scheduling: not forced on existing broker']
let report, originalOffsets, cleaned = false
try {
  await admin.connect()
  await admin.createTopics({ topics: topics.map(topic => ({ topic, numPartitions: 1, replicationFactor: 1 })), waitForLeaders: true })
  await producer.connect()
  await producer.send({ topic, messages: [
    { key: null, value: '{"case":"readonly","count":1}', headers: { multi: ['one', 'two'] } },
    { key: Buffer.alloc(0), value: Buffer.from([255, 0, 10]) },
    { value: 'z'.repeat(80000) },
  ] })
  await admin.setOffsets({ groupId: businessGroup, topic, partitions: [{ partition: 0, offset: '1' }] })
  originalOffsets = await admin.fetchOffsets({ groupId: businessGroup, topics: [topic] })
  const input = { dialect: 'kafka', name: 'Read-only acceptance', brokers: settings.brokers, tls: false,
    saslMechanism: settings.sasl?.mechanism || 'none', username: settings.sasl?.username || '', password: settings.sasl?.password || '', environment: 'pvt' }
  const connection = await service.open('owner', input, false)
  const tools = new Map(), events = [], emit = executions.emitWorkbench.bind(executions)
  executions.emitWorkbench = (owner, event) => { events.push(event); emit(owner, event) }
  registerKafkaAiTools({ tools: { register: tool => tools.set(tool.name, tool) } }, service, executions, id => id === 'owner')
  const invoke = async (tool, args = {}) => JSON.parse(await tools.get(tool).execute({ connectionId: connection.id, generation: connection.generation, ...args },
    { agent: { session: { id: 'owner' } }, callId: `${prefix}_call`, rootCallId: `${prefix}_root` }))
  const first = await invoke('kafka_topics', { search: prefix })
  assert.equal(first.topics.length, 100); assert.ok(first.nextCursor)
  const second = await invoke('kafka_topics', { search: prefix, cursor: first.nextCursor })
  assert.equal(new Set([...first.topics, ...second.topics]).size, topics.length)
  checks.push('Authenticated Topic search and text pagination')
  const groups = await invoke('kafka_groups', { search: businessGroup })
  assert.deepEqual(groups.groups, [businessGroup])
  const group = await invoke('kafka_group', { groupId: businessGroup })
  assert.equal(group.groupId, businessGroup)
  const linked = await invoke('kafka_group_topics', { groupId: businessGroup })
  assert.deepEqual(linked.topics, [topic])
  const lag = await invoke('kafka_group_topic', { groupId: businessGroup, topic })
  assert.deepEqual([lag.partitions[0].current, lag.partitions[0].end, lag.partitions[0].lag], ['1', '3', '2'])
  checks.push('Four group AI tools, real committed offsets and Lag')
  const peek = await invoke('kafka_peek', { topic, partition: 0, from: 'beginning', limit: 3 })
  assert.equal(peek.messages.length, 3)
  assert.equal(peek.messages[0].key.kind, 'null'); assert.equal(peek.messages[1].key.length, 0)
  assert.equal(peek.messages[1].value.kind, 'binary'); assert.equal(peek.messages[2].value.truncated, true)
  assert.deepEqual(peek.messages[0].headers.multi.map(item => item.text), ['one', 'two'])
  assert.ok(Buffer.byteLength(JSON.stringify(peek)) <= 1048576)
  checks.push('Bounded binary, empty, JSON, oversized values and repeated headers')
  const emptyRead = await service.executeText('owner', connection.id, connection.generation, `PEEK ${JSON.stringify(empty)} PARTITION 0 FROM BEGINNING`)
  assert.equal(emptyRead.complete, true); assert.equal(emptyRead.messages.length, 0)
  for (const result of [first, second, groups, group, linked, lag, peek]) {
    const record = executions.get('owner', result.executionId)
    assert.equal(record.type, 'tool'); assert.equal(record.callId, `${prefix}_call`); assert.equal(record.rootCallId, `${prefix}_root`)
    assert.equal(record.events.filter(event => event.kind === 'dispatched').length, 1)
    const finished = events.filter(event => event.type === 'EXECUTION_FINISHED' && event.executionId === result.executionId)
    assert.equal(finished.length, 1); assert.equal(finished[0].status, record.status)
  }
  const history = readFileSync(join(directory, 'ai-executions.json'), 'utf8')
  for (const secret of ['"case":"readonly"', 'zzzzzzzzzzzzzzzz', 'PRIVATE_TRANSACTION_ABORTED']) assert.ok(!history.includes(secret))
  const item = service.handleKnowledge('owner', { action: 'knowledge-publish', connectionId: connection.id,
    generation: connection.generation, text: `GROUP ${JSON.stringify(businessGroup)} TOPICS CURSOR 0`, title: 'Group topics' })
  assert.equal(item.sourceId, 'kafka')
  service.controlExecutionDocument('owner', connection.id, 'user', undefined, connection.generation, service.getExecutionDocument('owner', connection.id).revision)
  await assert.rejects(invoke('kafka_groups'), /接管/)
  checks.push('Single lifecycle/event, safe persisted history, knowledge and takeover')
  runtime = await openKafka(input)
  const direct = await peekKafkaPartition(runtime, { kind: 'peek', topic, partition: 0, from: 'beginning', limit: 1 }, undefined, 30000, id => productGroups.push(id))
  assert.equal(direct.messages.length, 1)
  for (const groupId of productGroups) assert.equal((await admin.fetchOffsets({ groupId, topics: [topic] }))[0].partitions[0].offset, '-1')
  const abort = new AbortController(); abort.abort()
  await assert.rejects(listKafkaTopics(runtime, {}, abort.signal), /取消/)
  assert.ok((await listKafkaTopics(runtime, { search: topic })).topics.includes(topic))
  checks.push('Actual product temporary group has no committed offset; cancelled read leaves Admin usable')
  try {
    transactionProducer = kafka.producer({ transactionalId: `${prefix}_txn`, idempotent: true, maxInFlightRequests: 1 })
    await transactionProducer.connect()
    const transaction = await transactionProducer.transaction()
    await transaction.send({ topic: transactionTopic, messages: [{ value: 'PRIVATE_TRANSACTION_ABORTED' }] })
    await transaction.abort()
  } catch {
    notRun.push('Aborted transaction fixture: existing broker transaction capability unavailable')
  }
  if (!notRun.some(item => item.startsWith('Aborted transaction fixture'))) {
    const filtered = await peekKafkaPartition(runtime, { kind: 'peek', topic: transactionTopic, partition: 0, from: 'beginning', limit: 20 }, undefined, 5000, id => productGroups.push(id))
    assert.equal(filtered.messages.length, 0)
    // Some brokers expose an empty initial range after abort; that is legitimately complete.
    assert.ok((filtered.reason === 'deadline' && filtered.complete === false)
      || (filtered.reason === 'high' && filtered.complete === true && BigInt(filtered.start) >= BigInt(filtered.high)))
    checks.push(`Aborted transaction: range [${filtered.start},${filtered.high}), ${filtered.reason}; no aborted payload exposed`)
    if (BigInt(filtered.start) < BigInt(filtered.high)) {
      const cancelling = new AbortController()
      let cancelTimer
      const cancelRuntime = { admin: runtime.admin, kafka: { consumer(config) {
        const consumer = runtime.kafka.consumer(config)
        return { ...consumer, async run(options) {
          await consumer.run(options)
          // Cancel only after the real public run API has started; no fake messages or private APIs.
          cancelTimer = setTimeout(() => cancelling.abort(), 200)
        } }
      } } }
      try {
        const cancelled = await peekKafkaPartition(cancelRuntime, { kind: 'peek', topic: transactionTopic, partition: 0, from: 'beginning', limit: 20 }, cancelling.signal, 10000, id => productGroups.push(id))
        assert.equal(cancelled.reason, 'cancelled'); assert.equal(cancelled.complete, false)
        assert.ok((await listKafkaTopics(runtime, { search: topic })).topics.includes(topic))
        checks.push('Cancellation during actual Consumer reading leaves shared Admin usable')
      } finally { clearTimeout(cancelTimer) }
    } else notRun.push('Cancellation during actual reading: aborted transaction exposed an empty initial range')
  }
  for (const groupId of productGroups) {
    const offsets = await admin.fetchOffsets({ groupId, topics: [topic, transactionTopic] })
    assert.ok(offsets.every(item => item.partitions.every(part => part.offset === '-1')))
  }
  assert.deepEqual(await admin.fetchOffsets({ groupId: businessGroup, topics: [topic] }), originalOffsets)
  report = { status: 'PASS', existingEnvironment: true, checks, businessOffsetUnchanged: true, productGroupsWithoutCommits: productGroups.length, notRun }
} finally {
  await service.dispose(); executions.dispose()
  await closeKafka(runtime)
  await transactionProducer?.disconnect().catch(() => {})
  await producer.disconnect().catch(() => {})
  // Exact IDs created by this invocation; no wildcard deletion of other clients' temporary groups.
  if (originalOffsets) await admin.deleteGroups([businessGroup, ...productGroups])
  await admin.deleteTopics({ topics })
  const left = (await admin.listTopics()).filter(name => name.startsWith(prefix))
  assert.deepEqual(left, [], 'Run-owned Topics must be cleaned')
  cleaned = true
  await admin.disconnect()
  rmSync(directory, { recursive: true, force: true })
}
assert.equal(cleaned, true)
mkdirSync('artifacts', { recursive: true })
writeFileSync('artifacts/kafka-readonly-existing-report.json', JSON.stringify({ ...report, cleanup: 'PASS' }, null, 2))
console.log(JSON.stringify({ status: report.status, checks: report.checks.length, cleanup: 'PASS', report: 'artifacts/kafka-readonly-existing-report.json' }))

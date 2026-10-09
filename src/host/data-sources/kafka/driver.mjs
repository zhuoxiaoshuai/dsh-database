import kafkaPackage from 'kafkajs'
import { randomUUID } from 'node:crypto'
import { kafkaWorkerConfig } from './connection.mjs'
import { appendKafkaMessage, kafkaNamePage, kafkaFailureHealth, MAX_KAFKA_RESULT_BYTES } from './result.mjs'
import { assertKafkaGroupId, assertKafkaTopic, kafkaPeekStart, kafkaBytes } from './command.mjs'
import { groupTopicRows, unionTopicNames, visibleGroupIds } from './group.mjs'
import { createKafkaOperationScope, withKafkaReadScope } from './operation-scope.mjs'

const { Kafka, logLevel, AssignerProtocol, ConfigResourceTypes } = kafkaPackage

export async function openKafka(config) {
  const kafka = new Kafka({ ...kafkaWorkerConfig(config), logLevel: logLevel.ERROR })
  const admin = kafka.admin()
  try {
    await admin.connect()
    const topics = await admin.listTopics()
    return { kafka, admin, version: 'Kafka', topics: topics.length }
  } catch (error) {
    let timer
    try { await Promise.race([admin.disconnect().catch(() => {}), new Promise(done => { timer = setTimeout(done, 1000) })]) }
    finally { clearTimeout(timer) }
    throw error
  }
}

export async function closeKafka(runtime) {
  try { await runtime?.admin?.disconnect() } catch { /* worker owns the connection */ }
}

function wireHeaders(headers) {
  return headers && Object.fromEntries(Object.entries(headers).map(([name, item]) =>
    [name, Array.isArray(item) ? item.map(part => kafkaBytes(part, `Header ${name}`)) : kafkaBytes(item, `Header ${name}`)]))
}

async function existingTopic(runtime, topic) {
  const metadata = await runtime.admin.fetchTopicMetadata({ topics: [topic] })
  const found = metadata.topics.find(item => item.name === topic)
  if (!found) throw Object.assign(new Error('Topic 不存在或无权查看。'), { effect: 'none' })
  return found
}

/** A single acknowledged send. No automatic topic creation, replay, or retry after an uncertain receipt. */
export async function produceKafkaMessage(runtime, operation, signal) {
  if (signal?.aborted) throw Object.assign(new Error('发布已取消。'), { effect: 'none' })
  const topic = await existingTopic(runtime, operation.topic)
  if (operation.partition !== undefined && !topic.partitions.some(item => item.partitionId === operation.partition))
    throw Object.assign(new Error('Partition 不存在。'), { effect: 'none' })
  if (signal?.aborted) throw Object.assign(new Error('发布已取消。'), { effect: 'none' })
  const producer = runtime.kafka.producer({ allowAutoTopicCreation: false, retry: { retries: 0 } })
  try {
    await producer.connect()
    if (signal?.aborted) throw Object.assign(new Error('发布已取消。'), { effect: 'none' })
    let response
    try {
      response = await producer.send({ topic: operation.topic, acks: -1, timeout: 10000, messages: [{
        ...(operation.key !== undefined ? { key: kafkaBytes(operation.key, 'Key') } : {}),
        value: operation.kind === 'tombstone' ? null : kafkaBytes(operation.value, 'Value'),
        ...(operation.partition !== undefined ? { partition: operation.partition } : {}),
        ...(operation.headers !== undefined ? { headers: wireHeaders(operation.headers) } : {}),
      }] })
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error('Kafka 发布回执丢失。'), { effect: 'unknown' })
    }
    const acknowledged = response.find(item => item.topicName === operation.topic)
    if (!acknowledged || acknowledged.errorCode) throw Object.assign(new Error('Broker 回执无法确认发布结果。'), { effect: 'unknown' })
    return { kind: 'produce', topic: operation.topic, partition: acknowledged.partition,
      ...(acknowledged.baseOffset && acknowledged.baseOffset !== '-1' ? { baseOffset: acknowledged.baseOffset } : {}),
      valueBytes: operation.kind === 'tombstone' ? 0 : kafkaBytes(operation.value, 'Value').length, acknowledged: true, elapsedMs: 0,
      ...(operation.replayFrom ? { replayFrom: operation.replayFrom } : {}) }
  } catch (error) {
    if (error && typeof error === 'object' && !('effect' in error)) Object.assign(error, { effect: 'none' })
    throw error
  } finally {
    await Promise.race([producer.disconnect().catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))])
  }
}

export async function produceKafkaBatch(runtime, operation, signal, onReceipt) {
  const receipts = []
  for (let index = 0; index < operation.messages.length; index++) {
    if (signal?.aborted) return { kind: 'produce-batch', topic: operation.topic, receipts, failedIndex: index,
      notSent: operation.messages.length - index, status: 'cancelled', message: '剩余消息未发送。' }
    onReceipt?.({ kind: 'produce-batch', topic: operation.topic, receipts: [...receipts], failedIndex: index,
      notSent: operation.messages.length - index - 1, status: 'unknown' })
    try {
      const receipt = await produceKafkaMessage(runtime, { kind: 'produce', topic: operation.topic, ...operation.messages[index] }, signal)
      receipts.push({ index, partition: receipt.partition, ...(receipt.baseOffset ? { baseOffset: receipt.baseOffset } : {}),
        valueBytes: receipt.valueBytes, acknowledged: true })
      onReceipt?.({ kind: 'produce-batch', topic: operation.topic, receipts: [...receipts], notSent: operation.messages.length - index - 1 })
    } catch (error) {
      return { kind: 'produce-batch', topic: operation.topic, receipts, failedIndex: index,
        notSent: operation.messages.length - index - 1, status: error?.effect === 'unknown' ? 'unknown' : signal?.aborted ? 'cancelled' : 'failed',
        message: error?.effect === 'unknown' ? '当前条结果未知；核对后再决定是否重发。' : '当前条未确认发布；后续条目未发送。' }
    }
  }
  return { kind: 'produce-batch', topic: operation.topic, receipts, notSent: 0, status: 'succeeded' }
}

export async function describeKafkaTopicConfig(runtime, topic, signal) {
  return withKafkaReadScope(signal, async read => {
    await read(() => existingTopic(runtime, topic))
    const response = await read(() => runtime.admin.describeConfigs({ includeSynonyms: false,
      resources: [{ type: ConfigResourceTypes.TOPIC, name: topic,
        configNames: ['cleanup.policy', 'retention.ms', 'delete.retention.ms', 'min.insync.replicas', 'segment.bytes'] }] }))
    const resource = response.resources?.find(item => item.resourceName === topic)
    if (!resource || resource.errorCode) throw new Error('Topic 配置不可读。')
    return { kind: 'topic-config', topic, configs: Object.fromEntries((resource.configEntries || [])
      .filter(item => !item.isSensitive).map(item => [item.configName, { value: item.configValue, isDefault: !!item.isDefault }])), elapsedMs: 0 }
  })
}

export async function kafkaTimeOffsets(runtime, operation, signal) {
  return withKafkaReadScope(signal, async read => {
    await read(() => existingTopic(runtime, operation.topic))
    const [positions, ranges] = await Promise.all([
      read(() => runtime.admin.fetchTopicOffsetsByTimestamp(operation.topic, operation.timestamp)),
      read(() => runtime.admin.fetchTopicOffsets(operation.topic)),
    ])
    return { kind: 'time-offsets', topic: operation.topic, timestamp: operation.timestamp,
      partitions: ranges.map(range => { const found = positions.find(item => item.partition === range.partition)
        return { partition: range.partition, low: String(range.low), high: String(range.high),
          offset: String(found?.offset ?? '-1') === '-1' ? String(range.high) : String(found.offset),
          noLaterMessage: String(found?.offset ?? '-1') === '-1' } }), elapsedMs: 0 }
  })
}

function encodedBytes(value) {
  if (!value || value.kind === 'null' || value.truncated) return null
  return value.kind === 'text' ? Buffer.from(value.text || '', 'utf8') : Buffer.from(value.base64 || '', 'base64')
}

export async function scanKafkaMessages(runtime, operation, signal) {
  const started = Date.now()
  const positions = operation.timestamp !== undefined
    ? await kafkaTimeOffsets(runtime, { kind: 'time-offsets', topic: operation.topic, timestamp: operation.timestamp }, signal) : null
  const starts = Object.fromEntries(operation.partitions.map(partition => [partition,
    operation.offsets?.[partition] ?? positions?.partitions.find(item => item.partition === partition)?.offset]))
  if (Object.values(starts).some(item => item === undefined)) throw new Error('扫描分区不存在。')
  const wantedKey = operation.key === undefined ? null : kafkaBytes(operation.key, '搜索 Key')
  const wantedHeader = operation.header === undefined ? null : kafkaBytes(operation.header.value, '搜索 Header')
  const matches = [], nextOffsets = { ...starts }, ranges = []
  let inspected = 0, matchBytes = 0, complete = true, reason = ''
  for (const partition of operation.partitions) {
    const remainingMs = 30000 - (Date.now() - started)
    if (signal?.aborted || remainingMs <= 0 || inspected >= 200 || matches.length >= 50) { complete = false; reason = signal?.aborted ? 'cancelled' : remainingMs <= 0 ? 'deadline' : 'limit'; break }
    const peek = await peekKafkaPartition(runtime, { kind: 'peek', topic: operation.topic, partition,
      from: 'offset', offset: starts[partition], limit: Math.min(200 - inspected, 200) }, signal, remainingMs)
    let stopped = false
    for (const message of peek.messages) {
      inspected += 1
      nextOffsets[partition] = (BigInt(message.offset) + 1n).toString()
      if (wantedKey && !encodedBytes(message.key)?.equals(wantedKey)) continue
      if (wantedHeader) {
        const header = message.headers?.[operation.header.name]
        const parts = Array.isArray(header) ? header : header ? [header] : []
        if (!parts.some(part => encodedBytes(part)?.equals(wantedHeader))) continue
      }
      const match = { ...message, partition }
      const bytes = Buffer.byteLength(JSON.stringify(match), 'utf8')
      if (matchBytes + bytes > MAX_KAFKA_RESULT_BYTES - 32768) {
        nextOffsets[partition] = message.offset
        stopped = true; reason = 'bytes'; break
      }
      matches.push(match); matchBytes += bytes
      if (matches.length >= 50) { stopped = true; reason = 'limit'; break }
    }
    if (!peek.messages.length && peek.complete) nextOffsets[partition] = peek.high
    ranges.push({ partition, low: peek.low, high: peek.high, complete: peek.complete && !stopped,
      reason: stopped ? reason : peek.reason })
    if (stopped || !peek.complete) { complete = false; reason ||= peek.reason || 'limit'; break }
  }
  if (ranges.length < operation.partitions.length) complete = false
  matches.sort((a, b) => Number(a.timestamp) - Number(b.timestamp) || a.partition - b.partition || (BigInt(a.offset) < BigInt(b.offset) ? -1 : 1))
  return { kind: 'scan', topic: operation.topic, partitions: operation.partitions, messages: matches,
    inspected, nextOffsets, ranges, complete, reason, ...(operation.key !== undefined ? { key: operation.key } : {}),
    ...(operation.header !== undefined ? { header: operation.header } : {}), elapsedMs: Date.now() - started }
}

export async function produceKafkaTombstone(runtime, operation, signal) {
  const config = await describeKafkaTopicConfig(runtime, operation.topic, signal)
  if (!String(config.configs['cleanup.policy']?.value || '').split(',').includes('compact'))
    throw Object.assign(new Error('Topic 未启用日志压缩，不能发布墓碑。'), { effect: 'none' })
  const receipt = await produceKafkaMessage(runtime, operation, signal)
  return { ...receipt, kind: 'tombstone' }
}

export async function createKafkaTopic(runtime, operation, signal) {
  if (signal?.aborted) throw Object.assign(new Error('创建已取消。'), { effect: 'none' })
  const cluster = await runtime.admin.describeCluster()
  if (operation.replicationFactor > (cluster.brokers || []).length) throw Object.assign(new Error('复制因子超过 Broker 数量。'), { effect: 'none' })
  const config = { topic: operation.topic, numPartitions: operation.partitions, replicationFactor: operation.replicationFactor,
    configEntries: [{ name: 'cleanup.policy', value: operation.cleanupPolicy }] }
  const validate = await runtime.admin.createTopics({ validateOnly: true, waitForLeaders: false, topics: [config] })
  if (validate === false) throw Object.assign(new Error('Topic 已存在。'), { effect: 'none' })
  if (signal?.aborted) throw Object.assign(new Error('创建已取消。'), { effect: 'none' })
  let created
  try { created = await runtime.admin.createTopics({ waitForLeaders: true, topics: [config] }) }
  catch (error) { throw Object.assign(error, { effect: 'unknown' }) }
  if (created === false) throw Object.assign(new Error('Topic 已存在，创建结果需要核对。'), { effect: 'unknown' })
  let metadata
  try { metadata = await existingTopic(runtime, operation.topic) } catch { throw Object.assign(new Error('Topic 创建回执已收到，但元数据暂不可读。'), { effect: 'unknown' }) }
  return { kind: 'create-topic', topic: operation.topic, partitionCount: metadata.partitions.length,
    replicationFactor: operation.replicationFactor, cleanupPolicy: operation.cleanupPolicy, acknowledged: true }
}

export async function setKafkaGroupOffsets(runtime, operation, signal) {
  const described = await runtime.admin.describeGroups([operation.groupId])
  const group = described.groups?.find(item => item.groupId === operation.groupId)
  if (!group || (group.members || []).length || !['Empty', 'Dead'].includes(String(group.state)))
    throw Object.assign(new Error('消费组不存在或仍有运行成员。'), { effect: 'none' })
  const committed = await runtime.admin.fetchOffsets({ groupId: operation.groupId, topics: [operation.topic], resolveOffsets: false })
  const rows = committed.find(item => item.topic === operation.topic)?.partitions || []
  const current = Object.fromEntries(rows.map(item => [item.partition, String(item.offset) === '-1' ? null : String(item.offset)]))
  const ranges = await runtime.admin.fetchTopicOffsets(operation.topic)
  const times = operation.timestamp === undefined ? null : await runtime.admin.fetchTopicOffsetsByTimestamp(operation.topic, operation.timestamp)
  const targets = {}
  for (const [id, expected] of Object.entries(operation.expected)) {
    const partition = Number(id), actual = current[id] ?? null
    if (actual !== expected) throw Object.assign(new Error(`分区 ${id} 的已提交位置已变化。`), { effect: 'none' })
    const range = ranges.find(item => item.partition === partition)
    if (!range) throw Object.assign(new Error(`分区 ${id} 不存在。`), { effect: 'none' })
    const timed = times?.find(item => item.partition === partition)
    const target = operation.offsets?.[id] ?? (String(timed?.offset ?? '-1') === '-1' ? String(range.high) : String(timed.offset))
    if (BigInt(target) < BigInt(range.low) || BigInt(target) > BigInt(range.high)) throw Object.assign(new Error(`分区 ${id} 的目标位置超出保留范围。`), { effect: 'none' })
    targets[id] = target
  }
  if (signal?.aborted) throw Object.assign(new Error('位点调整已取消。'), { effect: 'none' })
  try { await runtime.admin.setOffsets({ groupId: operation.groupId, topic: operation.topic,
    partitions: Object.entries(targets).map(([partition, offset]) => ({ partition: Number(partition), offset })) }) }
  catch (error) { throw Object.assign(error, { effect: 'unknown' }) }
  let after
  try { after = await runtime.admin.fetchOffsets({ groupId: operation.groupId, topics: [operation.topic], resolveOffsets: false }) }
  catch { throw Object.assign(new Error('位点写入已派发，回读失败。'), { effect: 'unknown' }) }
  const changed = after.find(item => item.topic === operation.topic)?.partitions || []
  if (Object.entries(targets).some(([id, target]) => String(changed.find(item => item.partition === Number(id))?.offset) !== target))
    throw Object.assign(new Error('位点回读与目标不一致，请核验。'), { effect: 'unknown' })
  return { kind: 'set-group-offsets', groupId: operation.groupId, topic: operation.topic, before: operation.expected,
    after: targets, timestamp: operation.timestamp, acknowledged: true }
}

export async function listKafkaTopics(runtime, input = {}, signal) {
  return withKafkaReadScope(signal, async read => {
  const topics = (await read(() => runtime.admin.listTopics())).sort()
  const search = typeof input.search === 'string' ? input.search.slice(0, 256).toLowerCase() : ''
  const filtered = search ? topics.filter(topic => topic.toLowerCase().includes(search)) : topics
  return kafkaNamePage(filtered, input.cursor, 'topics', { kind: 'topics', ...(search ? { search } : {}) })
  })
}

export async function describeKafkaTopic(runtime, topic, signal) {
  assertKafkaTopic(topic)
  return withKafkaReadScope(signal, async read => {
  const metadata = await read(() => runtime.admin.fetchTopicMetadata({ topics: [topic] }))
  const found = metadata.topics.find(item => item.name === topic)
  if (!found) throw new Error('Topic 不存在或无权查看。')
  const offsets = await read(() => runtime.admin.fetchTopicOffsets(topic))
  return { kind: 'describe', topic, partitions: found.partitions.map(item => {
    const range = offsets.find(offset => offset.partition === item.partitionId)
    return { partition: item.partitionId, leader: item.leader, replicas: item.replicas,
      low: String(range?.low ?? ''), high: String(range?.high ?? '') }
  }), elapsedMs: 0 }
  })
}

export async function peekKafkaPartition(runtime, operation, signal, deadlineMs = 30000, onGroupCreated) {
  const scope = createKafkaOperationScope(signal, deadlineMs)
  let offsets
  try {
    if (scope.reason) throw new Error('读取已取消。')
    offsets = await scope.race(runtime.admin.fetchTopicOffsets(operation.topic))
    if (scope.reason) throw new Error(scope.reason === 'deadline' ? 'Kafka 读取超过截止时间。' : '读取已取消。')
  } catch (error) { scope.dispose(); throw error }
  const range = offsets.find(item => item.partition === operation.partition)
  if (!range) { scope.dispose(); throw new Error('分区不存在或无权读取。') }
  const low = String(range.low), high = String(range.high)
  let start
  try { start = kafkaPeekStart(operation, low, high) } catch (error) { scope.dispose(); throw error }
  const result = { kind: 'peek', topic: operation.topic, partition: operation.partition, low, high, start,
    messages: [], bytes: 0, complete: false, reason: '', elapsedMs: 0 }
  if (BigInt(start) >= BigInt(high)) { result.complete = true; result.reason = 'high'; result.elapsedMs = scope.elapsedMs; scope.dispose(); return result }
  const groupId = `dsh-peek-${randomUUID()}`
  onGroupCreated?.(groupId)
  let consumer, removeCrash
  try {
    consumer = runtime.kafka.consumer({ groupId, allowAutoTopicCreation: false, maxWaitTimeInMs: 1000,
      retry: { retries: 0, restartOnFailure: async () => false } })
    removeCrash = typeof consumer.on === 'function' ? consumer.on(consumer.events.CRASH, () => scope.settle('error')) : () => {}
  } catch (error) { scope.dispose(); throw error }
  let started = false
  let ready = false
  try {
    if (scope.reason) return result
    await scope.race(consumer.connect())
    if (scope.reason) return result
    await scope.race(consumer.subscribe({ topic: operation.topic, fromBeginning: false }))
    if (scope.reason) return result
    await scope.race(consumer.run({ autoCommit: false, eachMessage: async ({ topic, partition, message }) => {
      if (!started || scope.reason || signal?.aborted || topic !== operation.topic || partition !== operation.partition) return
      const offset = BigInt(message.offset)
      if (offset < BigInt(start)) return
      // A visible record beyond the captured high proves the ordered scan crossed our range.
      if (offset >= BigInt(high)) { scope.settle('high'); return }
      if (result.messages.some(item => item.offset === String(message.offset))) return
      if (!appendKafkaMessage(result, message)) { scope.settle('bytes'); return }
      if (offset + 1n >= BigInt(high)) scope.settle('high')
      else if (result.messages.length >= operation.limit) scope.settle('limit')
    } }))
    if (scope.reason) return result
    ready = true
    consumer.seek({ topic: operation.topic, partition: operation.partition, offset: start })
    started = true
    if (signal?.aborted) scope.settle('cancelled')
    await scope.done
    result.reason = scope.reason
    result.complete = scope.reason === 'high'
    if (scope.reason === 'limit' && result.messages.length < operation.limit) result.reason = 'deadline'
    return result
  } catch (error) {
    if (!result.messages.length) throw error
    scope.settle('error')
    result.reason = scope.reason
    return result
  } finally {
    removeCrash()
    result.reason ||= scope.reason
    result.elapsedMs = scope.elapsedMs
    scope.dispose()
    // Stop outside eachMessage: KafkaJS may wait for that callback during shutdown.
    const cleanupStarted = Date.now()
    const closeWithin = async work => {
      let timer
      const remaining = 1000 - (Date.now() - cleanupStarted)
      if (remaining <= 0) throw new Error('Kafka Consumer 清理超时。')
      try { return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Kafka Consumer 清理超时。')), remaining) })]) }
      finally { clearTimeout(timer) }
    }
    let cleanupError
    try { await closeWithin(() => consumer.stop()) } catch (error) { cleanupError = error }
    if (!cleanupError) try { await closeWithin(() => consumer.disconnect()) } catch (error) { cleanupError = error }
    if (cleanupError || (!ready && (scope.reason === 'deadline' || scope.reason === 'cancelled'))) {
      const failure = new Error('Kafka Consumer 未能关闭，连接需要重新建立。')
      failure.recycleWorker = true
      throw failure
    }
  }
}

function assignmentOf(buffer) {
  if (!buffer || buffer.length === 0) return {}
  try {
    const decoded = AssignerProtocol.MemberAssignment.decode(buffer)
    const assignment = decoded?.assignment || {}
    const topics = {}
    for (const [topic, partitions] of Object.entries(assignment)) {
      topics[topic] = (partitions || []).filter(id => Number.isSafeInteger(id) && id >= 0 && id <= 2147483647)
    }
    return topics
  } catch {
    return {}
  }
}

function memberView(member) {
  return {
    memberId: String(member.memberId || ''),
    clientId: String(member.clientId || ''),
    clientHost: String(member.clientHost || ''),
    assignment: assignmentOf(member.memberAssignment),
  }
}

export async function listKafkaGroups(runtime, input = {}, signal) {
  return withKafkaReadScope(signal, async read => {
  const listed = await read(() => runtime.admin.listGroups())
  const ids = visibleGroupIds((listed.groups || []).map(group => group.groupId))
  const search = typeof input.search === 'string' ? input.search.slice(0, 256).toLowerCase() : ''
  const filtered = search ? ids.filter(id => id.toLowerCase().includes(search)) : ids
  return kafkaNamePage(filtered, input.cursor, 'groups', { kind: 'groups', ...(search ? { search } : {}) })
  })
}

async function readGroup(runtime, groupId, read) {
  assertKafkaGroupId(groupId)
  const described = await read(() => runtime.admin.describeGroups([groupId]))
  const group = (described.groups || []).find(item => item.groupId === groupId)
  if (!group) throw new Error('消费组不存在或无权查看。')
  return {
    kind: 'group', groupId, state: String(group.state || ''), protocol: String(group.protocol || ''),
    protocolType: String(group.protocolType || ''), members: (group.members || []).map(memberView), elapsedMs: 0,
  }
}

export async function describeKafkaGroup(runtime, groupId, signal) {
  return withKafkaReadScope(signal, read => readGroup(runtime, groupId, read))
}

export async function listKafkaGroupTopics(runtime, groupId, input = {}, signal) {
  return withKafkaReadScope(signal, async read => {
  const described = await readGroup(runtime, groupId, read)
  // Empty topics is encoded as a null OffsetFetch list, so this returns committed topics without reading end offsets.
  const committed = await read(() => runtime.admin.fetchOffsets({ groupId, topics: [] }))
  const assigned = described.members.flatMap(member => Object.keys(member.assignment))
  const committedNames = (committed || []).map(item => item.topic)
  return kafkaNamePage(unionTopicNames(assigned, committedNames), input.cursor, 'topics', { kind: 'group-topics', groupId })
  })
}

export async function describeKafkaGroupTopic(runtime, groupId, topic, signal) {
  assertKafkaTopic(topic)
  return withKafkaReadScope(signal, async read => {
  const described = await readGroup(runtime, groupId, read)
  const committed = await read(() => runtime.admin.fetchOffsets({ groupId, topics: [topic] }))
  let ends = null
  try {
    const ranges = await read(() => runtime.admin.fetchTopicOffsets(topic))
    ends = (ranges || []).map(range => ({ partition: range.partition, high: range.high }))
  } catch (error) {
    if (error?.name === 'KafkaReadCancelled' || error?.name === 'KafkaReadDeadline' || kafkaFailureHealth(error)) throw error
    ends = null
  }
  const topicOffsets = (committed || []).find(item => item.topic === topic)
  const assignment = []
  for (const member of described.members) {
    const label = member.clientId || member.memberId
    for (const partition of member.assignment[topic] || []) assignment.push({ partition, consumer: label })
  }
  return {
    kind: 'group-topic', groupId, topic, state: described.state,
    partitions: groupTopicRows({
      committed: (topicOffsets?.partitions || []).map(item => ({ partition: item.partition, offset: item.offset })),
      assignment, ends,
    }),
    elapsedMs: 0, ...(ends === null ? { warning: '无法读取分区末尾位置，末尾位置和积压量暂未知。' } : {}),
  }
  })
}

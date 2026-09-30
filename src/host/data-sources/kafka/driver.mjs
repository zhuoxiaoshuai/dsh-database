import { Kafka, logLevel, AssignerProtocol } from 'kafkajs'
import { randomUUID } from 'node:crypto'
import { kafkaWorkerConfig } from './connection.mjs'
import { appendKafkaMessage } from './result.mjs'
import { assertKafkaGroupId, assertKafkaTopic, kafkaPeekStart } from './command.mjs'
import { groupTopicRows, pageByCursor, unionTopicNames, visibleGroupIds } from './group.mjs'
import { createKafkaOperationScope } from './operation-scope.mjs'

export async function openKafka(config) {
  const kafka = new Kafka({ ...kafkaWorkerConfig(config), logLevel: logLevel.ERROR })
  const admin = kafka.admin()
  await admin.connect()
  try {
    const topics = await admin.listTopics()
    return { kafka, admin, version: 'Kafka', topics: topics.length }
  } catch (error) {
    await admin.disconnect()
    throw error
  }
}

export async function closeKafka(runtime) {
  try { await runtime?.admin?.disconnect() } catch { /* worker owns the connection */ }
}

export async function listKafkaTopics(runtime, input = {}) {
  const topics = (await runtime.admin.listTopics()).sort()
  const search = typeof input.search === 'string' ? input.search.slice(0, 256).toLowerCase() : ''
  const filtered = search ? topics.filter(topic => topic.toLowerCase().includes(search)) : topics
  const cursor = input.cursor === undefined ? 0 : Number(input.cursor)
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 1000000) throw new Error('Topic 页游标无效。')
  const page = filtered.slice(cursor, cursor + 100)
  return { kind: 'topics', topics: page, truncated: cursor + page.length < filtered.length,
    ...(cursor + page.length < filtered.length ? { nextCursor: String(cursor + page.length) } : {}), elapsedMs: 0 }
}

export async function describeKafkaTopic(runtime, topic) {
  const metadata = await runtime.admin.fetchTopicMetadata({ topics: [topic] })
  const found = metadata.topics.find(item => item.name === topic)
  if (!found) throw new Error('Topic 不存在或无权查看。')
  const offsets = await runtime.admin.fetchTopicOffsets(topic)
  return { kind: 'describe', topic, partitions: found.partitions.map(item => {
    const range = offsets.find(offset => offset.partition === item.partitionId)
    return { partition: item.partitionId, leader: item.leader, replicas: item.replicas,
      low: String(range?.low ?? ''), high: String(range?.high ?? '') }
  }), elapsedMs: 0 }
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
  if (BigInt(start) >= BigInt(high)) { result.complete = true; result.reason = 'high'; scope.dispose(); return result }
  const groupId = `dsh-peek-${randomUUID()}`
  onGroupCreated?.(groupId)
  const consumer = runtime.kafka.consumer({ groupId, allowAutoTopicCreation: false, maxWaitTimeInMs: 1000,
    retry: { retries: 0, restartOnFailure: async () => false } })
  const removeCrash = typeof consumer.on === 'function' ? consumer.on(consumer.events.CRASH, () => scope.settle('error')) : () => {}
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
      if (offset < BigInt(start) || offset >= BigInt(high)) return
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

export async function listKafkaGroups(runtime, input = {}) {
  const listed = await runtime.admin.listGroups()
  const ids = visibleGroupIds((listed.groups || []).map(group => group.groupId))
  const search = typeof input.search === 'string' ? input.search.slice(0, 256).toLowerCase() : ''
  const filtered = search ? ids.filter(id => id.toLowerCase().includes(search)) : ids
  const page = pageByCursor(filtered, input.cursor)
  return { kind: 'groups', groups: page.page, truncated: page.truncated, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), elapsedMs: 0 }
}

export async function describeKafkaGroup(runtime, groupId) {
  assertKafkaGroupId(groupId)
  const described = await runtime.admin.describeGroups([groupId])
  const group = (described.groups || []).find(item => item.groupId === groupId)
  if (!group) throw new Error('消费组不存在或无权查看。')
  return {
    kind: 'group', groupId, state: String(group.state || ''), protocol: String(group.protocol || ''),
    protocolType: String(group.protocolType || ''), members: (group.members || []).map(memberView), elapsedMs: 0,
  }
}

export async function listKafkaGroupTopics(runtime, groupId) {
  const described = await describeKafkaGroup(runtime, groupId)
  // Empty topics is encoded as a null OffsetFetch list, so this returns committed topics without reading end offsets.
  const committed = await runtime.admin.fetchOffsets({ groupId, topics: [] })
  const assigned = described.members.flatMap(member => Object.keys(member.assignment))
  const committedNames = (committed || []).map(item => item.topic)
  return { kind: 'group-topics', groupId, topics: unionTopicNames(assigned, committedNames) }
}

export async function describeKafkaGroupTopic(runtime, groupId, topic) {
  assertKafkaTopic(topic)
  const described = await describeKafkaGroup(runtime, groupId)
  const committed = await runtime.admin.fetchOffsets({ groupId, topics: [topic] })
  let ends = null
  try {
    const ranges = await runtime.admin.fetchTopicOffsets(topic)
    ends = (ranges || []).map(range => ({ partition: range.partition, high: range.high }))
  } catch {
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
    elapsedMs: 0,
  }
}

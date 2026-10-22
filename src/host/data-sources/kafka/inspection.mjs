import { describeKafkaGroup, describeKafkaGroupTopic, listKafkaTopics, listKafkaGroups } from './driver.mjs'
import { visibleGroupIds, unionTopicNames, summarizePartitions } from './group.mjs'
import { assertKafkaTopic, assertKafkaGroupId } from './command.mjs'
import { withKafkaReadScope } from './operation-scope.mjs'
import { kafkaFailureHealth, limitKafkaResult } from './result.mjs'

const caches = new WeakMap()
export async function cachedKafkaInspection(runtime, key, refresh, signal, action) {
  if (signal?.aborted) throw new Error('Kafka 读取已取消。')
  let cache = caches.get(runtime)
  if (!cache) { cache = new Map(); caches.set(runtime, cache) }
  const hit = cache.get(key)
  if (!refresh && hit && Date.now() - hit.time < 15000) return structuredClone(hit.value)
  const value = limitKafkaResult(await action())
  if (signal?.aborted) throw new Error('Kafka 读取已取消。')
  if (value.complete !== false && !value.resultTruncated && !value.failed) {
    const bytes = Buffer.byteLength(JSON.stringify(value))
    cache.delete(key)
    if (bytes <= 8 * 1024 * 1024) cache.set(key, { time: Date.now(), bytes, value: structuredClone(value) })
    let total = [...cache.values()].reduce((sum, item) => sum + item.bytes, 0)
    while (cache.size > 100 || total > 8 * 1024 * 1024) {
      const first = cache.keys().next().value; total -= cache.get(first).bytes; cache.delete(first)
    }
  }
  return value
}

const interrupted = error => ['KafkaReadCancelled', 'KafkaReadDeadline'].includes(error?.name)
const collected = () => new Date().toISOString()
export async function describeKafkaCatalog(runtime, kind, input, signal) {
  return withKafkaReadScope(signal, async read => {
    const page = await read(() => kind === 'topics' ? listKafkaTopics(runtime, input, signal) : listKafkaGroups(runtime, input, signal))
    const metadata = {}
    if (!page[kind].length) return { ...page, metadata, collectedAt: collected() }
    try {
      if (kind === 'topics') {
        const response = await read(() => runtime.admin.fetchTopicMetadata({ topics: page.topics }))
        for (const topic of response.topics || []) {
          const parts = topic.partitions || [], factors = parts.map(part => part.replicas.length)
          const unknown = !parts.length || parts.some(part => !Array.isArray(part.isr))
          const abnormal = !!topic.errorCode || parts.some(part => part.partitionErrorCode || part.leader < 0 || part.offlineReplicas?.length || (part.isr && part.isr.length < part.replicas.length))
          metadata[topic.name] = { partitionCount: parts.length, replicationFactor: factors.length ? `${Math.min(...factors)}${Math.min(...factors) !== Math.max(...factors) ? `–${Math.max(...factors)}` : ''}` : '-',
            health: abnormal ? '异常' : unknown ? '未知' : '正常' }
        }
      } else {
        const response = await read(() => runtime.admin.describeGroups(page.groups))
        for (const group of response.groups || []) metadata[group.groupId] = group.errorCode ? { state: '不可读', members: null }
          : { state: group.state || '未知', members: group.members?.length ?? 0 }
      }
    } catch (error) {
      if (signal?.aborted || kafkaFailureHealth(error) || interrupted(error)) throw error
      return { ...page, metadata, complete: false, warning: '列表指标部分不可读。', collectedAt: collected() }
    }
    return { ...page, metadata, collectedAt: collected() }
  })
}
export async function describeKafkaTopicGroups(runtime, topic, input = {}, signal, deadlineMs = 30000) {
  assertKafkaTopic(topic)
  const raw = String(input.cursor ?? '0')
  if (!/^(0|[1-9]\d*)$/.test(raw) || Number(raw) > 1000000) throw new Error('页游标无效。')
  const parentSignal = signal, controller = new AbortController(), cancel = () => controller.abort()
  parentSignal?.addEventListener('abort', cancel, { once: true })
  if (parentSignal?.aborted) cancel()
  signal = controller.signal
  try { return await withKafkaReadScope(signal, async read => {
    const response = await read(() => runtime.admin.listGroups())
    const ids = visibleGroupIds((response.groups || []).map(group => group.groupId))
    const start = Number(raw), candidates = ids.slice(start, start + 100)
    const results = new Array(candidates.length)
    let index = 0
    await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
      while (index < candidates.length) {
        const slot = index++, groupId = candidates[slot]
        try {
          let group = null, offsets = null
          try { group = await read(() => describeKafkaGroup(runtime, groupId, signal)) }
          catch (error) { if (signal?.aborted || kafkaFailureHealth(error) || interrupted(error)) throw error }
          try { offsets = await read(() => runtime.admin.fetchOffsets({ groupId, topics: [] })) }
          catch (error) { if (signal?.aborted || kafkaFailureHealth(error) || interrupted(error)) throw error }
          const assigned = group?.members.some(member => (member.assignment[topic] || []).length > 0) || false
          const committed = (offsets || []).some(item => item.topic === topic && (item.partitions || []).some(part => part.offset != null && String(part.offset) !== '-1' && !part.errorCode))
          const complete = group !== null && group.complete !== false && offsets !== null && !offsets.some(item => (item.partitions || []).some(part => part.errorCode))
          results[slot] = { complete, association: assigned || committed ? { groupId, assigned, committed, complete } : null }
        } catch (error) {
          if (signal?.aborted || kafkaFailureHealth(error)) throw error
          if (interrupted(error)) break
          results[slot] = { complete: false, association: null }
        }
      }
    }))
    let prefix = 0
    while (prefix < candidates.length && results[prefix]) prefix++
    const next = start + prefix, scanned = results.filter(Boolean).length
    const failed = results.filter(item => item && !item.complete).length
    const complete = next >= ids.length && failed === 0 && prefix === candidates.length
    return { kind: 'topic-groups', topic, associations: results.filter(Boolean).flatMap(item => item.association ? [item.association] : []),
      complete, scanned, failed, collectedAt: collected(),
      ...(next < ids.length ? { nextCursor: String(next) } : {}),
      ...(!complete ? { warning: `关联查询尚不完整：本页检查 ${scanned} 个组，${failed} 个组信息不完整；列表变化可能造成重复或遗漏。` } : {}) }
  }, deadlineMs) } finally { cancel(); parentSignal?.removeEventListener('abort', cancel) }
}

export async function describeKafkaGroupSummary(runtime, groupId, signal, deadlineMs = 30000) {
  assertKafkaGroupId(groupId)
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  try {
    return await withKafkaReadScope(controller.signal, async read => {
      const group = await read(() => describeKafkaGroup(runtime, groupId, controller.signal))
      let offsets = null
      try { offsets = await read(() => runtime.admin.fetchOffsets({ groupId, topics: [] })) }
      catch (error) { if (controller.signal.aborted || kafkaFailureHealth(error) || interrupted(error)) throw error }
      const names = unionTopicNames(group.members.flatMap(member => Object.keys(member.assignment)), (offsets || []).map(item => item.topic))
      const topics = [], partitions = []
      let complete = group.complete !== false && offsets !== null, index = 0
      await Promise.all(Array.from({ length: Math.min(4, names.length) }, async () => {
        while (index < names.length) {
          const topic = names[index++]
          const assigned = new Set(group.members.flatMap(member => member.assignment[topic] || [])).size
          try {
            const detail = await read(() => describeKafkaGroupTopic(runtime, groupId, topic, controller.signal))
            const summary = summarizePartitions(detail.partitions, detail.complete !== false)
            if (!summary.complete) complete = false
            topics.push({ topic, assignedPartitions: assigned, ...summary }); partitions.push(...detail.partitions)
          } catch (error) {
            if (signal?.aborted || kafkaFailureHealth(error)) throw error
            complete = false
            topics.push({ topic, assignedPartitions: assigned, ...summarizePartitions([], false) })
            if (interrupted(error)) break
          }
        }
      }))
      complete = complete && topics.length === names.length
      return { kind: 'group-summary', groupId, topics: topics.sort((a, b) => a.topic.localeCompare(b.topic)),
        topicCount: names.length, ...summarizePartitions(partitions, complete), collectedAt: collected(),
        ...(!complete ? { warning: '消费汇总不完整；总 Lag 未知，已知小计不代表全部积压。' } : {}) }
    }, deadlineMs)
  } finally { cancel(); signal?.removeEventListener('abort', cancel) }
}

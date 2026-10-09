import type { ExplorerProvider } from '../../explorer-provider.ts'

const topicRef = (topic: string) => `topic:${encodeURIComponent(topic)}`
const groupRef = (groupId: string) => `group:${encodeURIComponent(groupId)}`
const groupTopicRef = (groupId: string, topic: string) => `gtopic:${encodeURIComponent(groupId)}:${encodeURIComponent(topic)}`
const GROUPS = 'folder:groups'

function decodeComponent(value: string, max: number): string {
  let text: string
  try { text = decodeURIComponent(value) } catch { throw new Error('Kafka 对象引用无效。') }
  if (!text || text.length > max) throw new Error('Kafka 对象引用无效。')
  return text
}

function decodeRef(ref: string): { kind: 'topic' | 'partition' | 'group' | 'group-topic'; topic: string; partition?: number; groupId?: string } {
  if (ref.startsWith('gtopic:')) {
    const body = ref.slice('gtopic:'.length)
    const split = body.indexOf(':')
    if (split <= 0 || split === body.length - 1) throw new Error('Kafka 对象引用无效。')
    return { kind: 'group-topic', topic: decodeComponent(body.slice(split + 1), 249), groupId: decodeComponent(body.slice(0, split), 255) }
  }
  if (ref.startsWith('group:')) return { kind: 'group', topic: '', groupId: decodeComponent(ref.slice('group:'.length), 255) }
  const match = /^(topic|partition):(.+?)(?::(\d+))?$/.exec(ref)
  if (!match || (match[1] === 'topic' && match[3] !== undefined) || (match[1] === 'partition' && match[3] === undefined)) throw new Error('Kafka 对象引用无效。')
  const topic = decodeComponent(match[2], 249)
  const partition = match[3] === undefined ? undefined : Number(match[3])
  if (partition !== undefined && (!Number.isSafeInteger(partition) || partition < 0 || partition > 2147483647)) throw new Error('Kafka 分区引用无效。')
  return { kind: match[1] as 'topic' | 'partition', topic, partition }
}

export const kafkaExplorer: ExplorerProvider<'kafka'> = {
  id: 'kafka',
  readonlyActions: ['kafka-topics', 'kafka-describe', 'kafka-groups', 'kafka-group'],
  async list(transport, input, signal) {
    if (!transport.source) throw new Error('Kafka 对象读取通道不可用。')
    if (!input.parent) {
      const page = await transport.source('kafka-topics', { cursor: input.cursor || '0', search: input.search || '' }, signal)
      const topics = Array.isArray(page.topics) ? page.topics.filter((item): item is string => typeof item === 'string') : []
      return { sourceId: 'kafka', nodes: topics.map(topic => ({ ref: topicRef(topic), title: topic, kind: 'topic', hasChildren: false })),
        ...(typeof page.nextCursor === 'string' ? { nextCursor: page.nextCursor } : {}), complete: page.truncated !== true }
    }
    if (input.parent === GROUPS) {
      const page = await transport.source('kafka-groups', { cursor: input.cursor || '0', search: input.search || '' }, signal)
      const groups = Array.isArray(page.groups) ? page.groups.filter((item): item is string => typeof item === 'string') : []
      return { sourceId: 'kafka', nodes: groups.map(groupId => ({ ref: groupRef(groupId), title: groupId, kind: 'group', hasChildren: true })),
        ...(typeof page.nextCursor === 'string' ? { nextCursor: page.nextCursor } : {}), complete: page.truncated !== true }
    }
    const target = decodeRef(input.parent)
    if (target.kind === 'topic' || target.kind === 'partition') throw new Error('Topic 没有子节点。')
    if (target.kind !== 'group' || !target.groupId) throw new Error('Kafka 对象引用无效。')
    const page = await transport.source('kafka-group', { groupId: target.groupId, topics: true, cursor: input.cursor || '0' }, signal)
    const topics = Array.isArray(page.topics) ? page.topics.filter((item): item is string => typeof item === 'string') : []
    return { sourceId: 'kafka', nodes: topics.map(topic => ({ ref: groupTopicRef(target.groupId!, topic), title: topic, kind: 'group-topic', hasChildren: false, metadata: { groupId: target.groupId, topic } })),
      ...(typeof page.nextCursor === 'string' ? { nextCursor: page.nextCursor } : {}), complete: page.truncated !== true }
  },
  async read(transport, input, signal) {
    if (!transport.source) throw new Error('Kafka 对象读取通道不可用。')
    const target = decodeRef(input.ref)
    if (target.kind === 'group') return transport.source('kafka-group', { groupId: target.groupId }, signal)
    if (target.kind === 'group-topic') return transport.source('kafka-group', { groupId: target.groupId, topic: target.topic }, signal)
    const details = await transport.source('kafka-describe', { text: `DESCRIBE ${JSON.stringify(target.topic)}` }, signal)
    return { ...details, selectedPartition: target.partition,
      queryText: target.partition === undefined ? '' : `PEEK ${JSON.stringify(target.topic)} PARTITION ${target.partition} FROM LATEST LIMIT 20` }
  },
}

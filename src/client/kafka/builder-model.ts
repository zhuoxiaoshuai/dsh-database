import { assertKafkaGroupId, assertKafkaTopic, formatKafkaCommand, kafkaBytes } from '../../shared/kafka-command.mjs'

export const kafkaBuilderOperations = [
  { kind: 'topics', label: '列出 Topic', command: 'TOPICS', group: 'Topic' },
  { kind: 'describe', label: '查看 Topic', command: 'DESCRIBE', group: 'Topic' },
  { kind: 'topic-config', label: '查看 Topic 配置', command: 'TOPIC_CONFIG', group: 'Topic' },
  { kind: 'topic-groups', label: '查看关联消费组', command: 'TOPIC_GROUPS', group: 'Topic' },
  { kind: 'create-topic', label: '创建测试 Topic', command: 'CREATE_TOPIC', group: 'Topic', write: true },
  { kind: 'peek', label: '读取消息', command: 'PEEK', group: '消息' },
  { kind: 'time-offsets', label: '按时间定位', command: 'TIME_OFFSETS', group: '消息' },
  { kind: 'scan', label: '扫描消息', command: 'SCAN', group: '消息' },
  { kind: 'produce', label: '发布消息', command: 'PRODUCE', group: '消息', write: true },
  { kind: 'produce-batch', label: '批量发布', command: 'PRODUCE_BATCH', group: '消息', write: true },
  { kind: 'tombstone', label: '发布墓碑', command: 'TOMBSTONE', group: '消息', write: true },
  { kind: 'groups', label: '列出消费组', command: 'GROUPS', group: '消费组' },
  { kind: 'group', label: '查看消费组', command: 'GROUP', group: '消费组' },
  { kind: 'group-topics', label: '查看消费组 Topic', command: 'GROUP … TOPICS', group: '消费组' },
  { kind: 'group-topic', label: '查看消费进度', command: 'GROUP … TOPIC', group: '消费组' },
  { kind: 'set-group-offsets', label: '调整消费位点', command: 'SET_GROUP_OFFSETS', group: '消费组', write: true },
] as const
export type BuilderKind = typeof kafkaBuilderOperations[number]['kind']
export type ByteDraft = { encoding: 'utf8' | 'base64'; value: string }
export type HeaderDraft = { name: string; bytes: ByteDraft }
export type MessageDraft = {
  value: ByteDraft; keyEnabled: boolean; key: ByteDraft; partitionEnabled: boolean; partition: string
  headersEnabled: boolean; headers: HeaderDraft[]; replayEnabled: boolean; replayTopic: string; replayPartition: string; replayOffset: string
}
export type PartitionDraft = { partition: string; offset: string; expected: string; uncommitted: boolean }
export type BuilderDraft = {
  topic: string; groupId: string; search: string; cursor: string; partition: string; from: 'latest' | 'beginning' | 'offset'; offset: string; limit: string
  time: string; targetMode: 'offset' | 'time'; partitions: PartitionDraft[]; keyEnabled: boolean; key: ByteDraft; headerEnabled: boolean; header: HeaderDraft
  message: MessageDraft; messages: MessageDraft[]; partitionCount: string; replicationFactor: string; cleanupPolicy: 'delete' | 'compact'
}
export const byteDraft = (): ByteDraft => ({ encoding: 'utf8', value: '' })
export const messageDraft = (): MessageDraft => ({ value: byteDraft(), keyEnabled: false, key: byteDraft(), partitionEnabled: false, partition: '0', headersEnabled: false, headers: [], replayEnabled: false, replayTopic: '', replayPartition: '0', replayOffset: '' })
export const partitionDraft = (): PartitionDraft => ({ partition: '0', offset: '', expected: '', uncommitted: false })
export function newBuilderDraft(kind: BuilderKind): BuilderDraft {
  return { topic: kind === 'create-topic' ? 'dsh-test-' : '', groupId: '', search: '', cursor: '', partition: '0', from: 'latest', offset: '', limit: '20', time: '', targetMode: 'time', partitions: [partitionDraft()],
    keyEnabled: false, key: byteDraft(), headerEnabled: false, header: { name: '', bytes: byteDraft() }, message: messageDraft(), messages: [messageDraft()], partitionCount: '1', replicationFactor: '1', cleanupPolicy: 'delete' }
}
export type BuilderErrors = Record<string, string>

/** Form conversion only. Shared syntax remains the final validation authority. */
export function generateKafkaCommand(kind: BuilderKind, draft: BuilderDraft): { command: string; errors: BuilderErrors } {
  const errors: BuilderErrors = {}
  const issue = (path: string, message: string) => { errors[path] ??= message }
  const integer = (text: string, path: string, max: number, min = 0) => {
    if (!/^(0|[1-9]\d*)$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < min || Number(text) > max) issue(path, `请输入 ${min}～${max} 的整数。`)
    return Number(text)
  }
  const offset = (text: string, path: string) => {
    if (!/^(0|[1-9]\d*)$/.test(text) || BigInt(text || '0') > (1n << 63n) - 1n) issue(path, '请输入有效的非负 Offset（最大 9223372036854775807）。')
    return text
  }
  const name = (text: string, path: string, group = false) => {
    try { (group ? assertKafkaGroupId : assertKafkaTopic)(text) } catch (error) { issue(path, error instanceof Error ? error.message : '名称无效。') }
    return text
  }
  const bytes = (value: ByteDraft, path: string) => {
    const result = value.encoding === 'base64' ? { base64: value.value } : value.value
    try { kafkaBytes(result, '内容') } catch (error) { issue(path, error instanceof Error ? error.message : '内容无效。') }
    return result
  }
  const time = () => {
    const value = Date.parse(draft.time)
    if (!Number.isSafeInteger(value) || value < 0) issue('time', '请选择有效的日期时间。')
    return value
  }
  const message = (value: MessageDraft, path: string, tombstone = false) => {
    const result: Record<string, any> = tombstone ? {} : { value: bytes(value.value, `${path}.value`) }
    if (tombstone || value.keyEnabled) {
      result.key = bytes(value.key, `${path}.key`)
      if (tombstone && !value.key.value.length) issue(`${path}.key`, '墓碑必须提供非空 Key。')
    }
    if (value.partitionEnabled) result.partition = integer(value.partition, `${path}.partition`, 2147483647)
    if (value.headersEnabled) {
      const headers = new Map<string, any[]>()
      value.headers.forEach((header, index) => {
        const at = `${path}.headers.${index}`
        if (!header.name || new TextEncoder().encode(header.name).length > 128 || /[\u0000-\u001f\u007f]/u.test(header.name)) issue(`${at}.name`, 'Header 名称不能为空，且最多 128 字节。')
        const items = headers.get(header.name) || []
        items.push(bytes(header.bytes, `${at}.value`)); headers.set(header.name, items)
        if (items.length > 8) issue(`${at}.name`, '同名 Header 最多 8 个值。')
      })
      if (headers.size > 16) issue(`${path}.headers`, '最多 16 个不同 Header。')
      result.headers = Object.fromEntries([...headers].map(([key, values]) => [key, values.length === 1 ? values[0] : values]))
    }
    if (!tombstone && value.replayEnabled) result.replayFrom = { topic: name(value.replayTopic, `${path}.replayTopic`), partition: integer(value.replayPartition, `${path}.replayPartition`, 2147483647), offset: offset(value.replayOffset, `${path}.replayOffset`) }
    return result
  }
  const op: Record<string, any> = { kind }
  if (!['topics', 'groups', 'group', 'group-topics'].includes(kind)) op.topic = name(draft.topic, 'topic')
  if (['group', 'group-topics', 'group-topic', 'set-group-offsets'].includes(kind)) op.groupId = name(draft.groupId, 'groupId', true)
  if (['topics', 'groups'].includes(kind) && draft.search !== '') {
    op.search = draft.search
    if (draft.search.length > 256 || /[\u0000-\u001f\u007f]/u.test(draft.search)) issue('search', '名称片段最多 256 字符，不能包含控制字符。')
  }
  if (['topics', 'groups', 'topic-groups', 'group-topics'].includes(kind) && draft.cursor !== '') {
    integer(draft.cursor, 'cursor', 1000000); op.cursor = draft.cursor
  }
  if (kind === 'peek') {
    op.partition = integer(draft.partition, 'partition', 2147483647); op.from = draft.from; op.limit = integer(draft.limit, 'limit', 200, 1)
    if (draft.from === 'offset') op.offset = offset(draft.offset, 'offset')
  }
  if (kind === 'time-offsets') op.timestamp = time()
  if (kind === 'scan' || kind === 'set-group-offsets') {
    if (!draft.partitions.length || draft.partitions.length > 8) issue('partitions', '请选择或添加 1～8 个分区。')
    const partitions = draft.partitions.map((row, index) => integer(row.partition, `partitions.${index}.partition`, 2147483647))
    if (new Set(partitions).size !== partitions.length) issue('partitions', '分区不能重复。')
    if (draft.targetMode === 'offset') op.offsets = Object.fromEntries(draft.partitions.map((row, index) => [row.partition, offset(row.offset, `partitions.${index}.offset`)]))
    else op.timestamp = time()
    if (kind === 'scan' || draft.targetMode === 'time') op.partitions = partitions
    if (kind === 'set-group-offsets') op.expected = Object.fromEntries(draft.partitions.map((row, index) => [row.partition, row.uncommitted ? null : offset(row.expected, `partitions.${index}.expected`)]))
    if (kind === 'scan' && draft.keyEnabled) op.key = bytes(draft.key, 'key')
    if (kind === 'scan' && draft.headerEnabled) {
      if (!draft.header.name || draft.header.name.length > 128) issue('header.name', '请输入 Header 名称，最多 128 字符。')
      op.header = { name: draft.header.name, value: bytes(draft.header.bytes, 'header.value') }
    }
  }
  if (kind === 'produce' || kind === 'tombstone') Object.assign(op, message(draft.message, 'message', kind === 'tombstone'))
  if (kind === 'produce-batch') {
    if (draft.messages.length < 1 || draft.messages.length > 10) issue('messages', '批量发布需要 1～10 条消息。')
    op.messages = draft.messages.map((item, index) => message(item, `messages.${index}`))
  }
  if (kind === 'create-topic') {
    if (!draft.topic.startsWith('dsh-test-')) issue('topic', '仅允许 dsh-test- 前缀。')
    op.partitions = integer(draft.partitionCount, 'partitionCount', 32, 1)
    op.replicationFactor = integer(draft.replicationFactor, 'replicationFactor', 3, 1)
    op.cleanupPolicy = draft.cleanupPolicy
  }
  if (Object.keys(errors).length) return { command: '', errors }
  try { return { command: formatKafkaCommand(op), errors } }
  catch (error) {
    const message = error instanceof Error ? error.message : '参数无效。'
    const path = /64 KiB/.test(message) && kind !== 'produce-batch' ? (kind === 'tombstone' ? 'message.key' : 'message.value')
      : kind === 'produce-batch' && /KiB/.test(message) ? 'messages' : 'form'
    return { command: '', errors: { [path]: message } }
  }
}

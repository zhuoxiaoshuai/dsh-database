import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ConnectionService } from '../../connection-service.ts'
import type { ExecutionStore } from '../../execution-store.ts'
import { nativeErrorText } from '../../connect-error.mjs'
import { formatKafkaCommand, parseKafkaCommand } from './command.mjs'
import { resolveAiConnection } from '../../ai-connection-resolve.ts'

type ToolExecution = { callId?: string; rootCallId?: string; signal?: AbortSignal; agent?: { session?: { id?: string } } }
type Selection = { connectionId?: string; generation?: string }
const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
const writeKinds = new Set(['produce', 'produce-batch', 'tombstone', 'create-topic', 'set-group-offsets'])
const asObject = (raw: unknown, label: string): Record<string, unknown> => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} 必须是对象。`)
  return raw as Record<string, unknown>
}

const peekFrom = (value: unknown): 'beginning' | 'latest' | 'offset' => {
  const text = typeof value === 'string' ? value.trim().toUpperCase() : ''
  if (text === 'BEGINNING') return 'beginning'
  if (text === 'LATEST') return 'latest'
  if (text === 'OFFSET') return 'offset'
  throw new Error('from 必须是 BEGINNING、LATEST 或 OFFSET。')
}

export function registerKafkaAiTools(ctx: { tools: { register(tool: unknown): void } }, service: ConnectionService,
  executions: ExecutionStore, validOwner: (id: string) => boolean): void {
  const owner = (execution: ToolExecution) => {
    const id = execution.agent?.session?.id || ''
    if (!validOwner(id)) throw new Error('当前工具调用缺少有效对话身份。')
    return id
  }
  const selected = (session: string, args: Selection) => resolveAiConnection({
    connections: service.list(session),
    family: 'kafka',
    connectionId: args.connectionId,
    generation: args.generation,
  })
  const run = async (args: Selection, operation: Record<string, unknown>, execution: ToolExecution) => {
    const session = owner(execution)
    const resolved = selected(session, args)
    if (!resolved.ok) return JSON.stringify(resolved)
    const connection = resolved.connection
    if (writeKinds.has(String(operation.kind)) && connection.environment !== 'sit') throw new Error('Kafka 写操作仅在 SIT 开放。')
    const command = formatKafkaCommand(operation)
    parseKafkaCommand(command)
    const before = service.getExecutionDocument(session, connection.id, connection.generation)
    if (before.controller !== 'ai') throw new Error('用户已接管 AI Query，无法继续操作 Kafka。')
    const published = service.updateExecutionDocument(session, connection.id, command, 'ai', before.revision, connection.generation)
    const current = service.getExecutionDocument(session, connection.id, connection.generation)
    if (current.controller !== 'ai' || current.revision !== published.revision || current.text !== command) throw new Error('AI Query 已被修改，操作没有执行。')
    try {
      const result = await service.executeText(session, connection.id, connection.generation, command, execution.signal, 'ai', execution.callId, published.revision, execution.rootCallId, undefined, { type: 'tool' })
      return JSON.stringify(result)
    } catch (error) {
      if (error instanceof Error) throw error
      throw new Error(nativeErrorText(error, 'Kafka 读取失败。'))
    }
  }
  ctx.tools.register(defineTool({
    name: 'kafka_status', description: '查看当前对话可用的 Kafka 连接、健康状态及连接代次。', parameters: {}, output,
    async execute(_args: unknown, execution: ToolExecution) {
      const session = owner(execution)
      if (execution.signal?.aborted) throw new Error('请求已取消。')
      await service.restoreRemembered(session)
      if (execution.signal?.aborted) throw new Error('请求已取消。')
      const record = executions.create({ conversationId: session, operation: 'kafka_status', initiator: 'ai', type: 'tool',
        callId: execution.callId, rootCallId: execution.rootCallId, title: '查看 Kafka 连接', historyVisible: true })
      try {
      const connections = service.list(session).filter(item => item.dialect === 'kafka').map(item => ({
        connectionId: item.id, generation: item.generation, name: item.name, environment: item.environment,
        live: item.live, health: item.health, version: item.version,
      }))
      executions.complete(record.executionId, 'succeeded', `可用连接 ${connections.length} 个。`)
      return JSON.stringify({
        executionId: record.executionId,
        connections,
        help: '先用返回的 connectionId 和 generation 调 kafka_topics。唯一已登录连接可省略这两个参数。',
      })
      } catch (error) {
        const message = nativeErrorText(error, 'Kafka 状态读取失败。')
        executions.complete(record.executionId, 'failed', message)
        if (error instanceof Error) throw error
        throw new Error(message)
      }
    },
  }))
  const required = {
    connectionId: { type: 'string' as const, description: '来自 kafka_status.connections。唯一已登录连接可省略。' },
    generation: { type: 'string' as const, description: '来自 kafka_status.connections。省略则用当前 generation。' },
  }
  const paging = { search: { type: 'string' as const }, cursor: { type: 'string' as const } }
  ctx.tools.register(defineTool({
    name: 'kafka_topics', description: '搜索并分页列出账号可见的 Topic。search 是名称片段；下一页使用返回的 nextCursor。', parameters: { ...required, ...paging }, output,
    execute: (args: Selection & { search?: string; cursor?: string }, execution: ToolExecution) => run(args, { kind: 'topics', search: args.search, cursor: args.cursor }, execution),
  }))
  ctx.tools.register(defineTool({
    name: 'kafka_describe', description: '查看一个 Topic 的分区、Leader、水位和副本。', parameters: { ...required, topic: { type: 'string', required: true } }, output,
    execute: (args: Selection & { topic?: string }, execution: ToolExecution) => run(args, { kind: 'describe', topic: args.topic }, execution),
  }))
  ctx.tools.register(defineTool({
    name: 'kafka_peek', description: '只读、限量读取单个 Topic 的单个分区；不会提交业务消费位置。', parameters: {
      ...required, topic: { type: 'string', required: true }, partition: { type: 'integer', required: true },
      from: { type: 'string', enum: ['BEGINNING', 'LATEST', 'OFFSET'], required: true, description: 'OFFSET 时再传 offset。' }, offset: { type: 'string' }, limit: { type: 'integer' },
    }, output,
    execute: (args: Selection & { topic?: string; partition?: number; from?: string; offset?: string; limit?: number }, execution: ToolExecution) =>
      run(args, { kind: 'peek', topic: args.topic, partition: args.partition, from: peekFrom(args.from), offset: args.offset, limit: args.limit }, execution),
  }))
  ctx.tools.register(defineTool({ name: 'kafka_groups', description: '搜索并分页读取可见消费组；不包含插件临时读取组。', parameters: { ...required, ...paging }, output,
    execute: (args: Selection & { search?: string; cursor?: string }, execution: ToolExecution) => run(args, { kind: 'groups', search: args.search, cursor: args.cursor }, execution) }))
  ctx.tools.register(defineTool({ name: 'kafka_group', description: '查看消费组状态、成员和分区分配；不会修改消费位置。', parameters: { ...required, groupId: { type: 'string', required: true } }, output,
    execute: (args: Selection & { groupId?: string }, execution: ToolExecution) => run(args, { kind: 'group', groupId: args.groupId }, execution) }))
  ctx.tools.register(defineTool({ name: 'kafka_group_topics', description: '分页列出消费组关联的 Topic，包括当前分配及已有提交位置的 Topic。', parameters: { ...required, groupId: { type: 'string', required: true }, cursor: { type: 'string' } }, output,
    execute: (args: Selection & { groupId?: string; cursor?: string }, execution: ToolExecution) => run(args, { kind: 'group-topics', groupId: args.groupId, cursor: args.cursor }, execution) }))
  ctx.tools.register(defineTool({ name: 'kafka_group_topic', description: '查看消费组在指定 Topic 的各分区提交位置、末尾位置和积压量；无法读取的指标显示未知。', parameters: { ...required, groupId: { type: 'string', required: true }, topic: { type: 'string', required: true } }, output,
    execute: (args: Selection & { groupId?: string; topic?: string }, execution: ToolExecution) => run(args, { kind: 'group-topic', groupId: args.groupId, topic: args.topic }, execution) }))
  ctx.tools.register(defineTool({ name: 'kafka_topic_config', description: '只读查看 Topic 的保留、压缩及副本相关配置。',
    parameters: { ...required, topic: { type: 'string', required: true } }, output,
    execute: (args: Selection & { topic?: string }, execution: ToolExecution) => run(args, { kind: 'topic-config', topic: args.topic }, execution) }))
  ctx.tools.register(defineTool({ name: 'kafka_time_offsets', description: '按毫秒时间戳定位各分区起始 offset，不读取消息。',
    parameters: { ...required, topic: { type: 'string', required: true }, timestamp: { type: 'integer', required: true } }, output,
    execute: (args: Selection & { topic?: string; timestamp?: number }, execution: ToolExecution) =>
      run(args, { kind: 'time-offsets', topic: args.topic, timestamp: args.timestamp }, execution) }))
  ctx.tools.register(defineTool({ name: 'kafka_scan', description: '跨最多 8 个分区有界扫描，按 key/header 精确匹配；返回续读位置和完整性。spec 是 SCAN 条件对象。',
    parameters: { ...required, spec: { type: 'object', required: true, additionalProperties: true, description: '含 topic、partitions，以及 offsets 或 timestamp。' } }, output,
    execute: (args: Selection & { spec?: unknown }, execution: ToolExecution) => run(args, { ...asObject(args.spec, '扫描条件'), kind: 'scan' }, execution) }))
  ctx.tools.register(defineTool({ name: 'kafka_produce', description: '仅 SIT 发布单条消息；文本或 Base64 二选一。结果未知时先核对，不能直接重试。',
    parameters: { ...required, topic: { type: 'string', required: true }, value: { type: 'string' }, valueBase64: { type: 'string' },
      key: { type: 'string' }, keyBase64: { type: 'string' }, headers: { type: 'object', additionalProperties: true, description: 'Header 名到文本或 {base64}。' }, partition: { type: 'integer' } }, output,
    execute: (args: Selection & { topic?: string; value?: string; valueBase64?: string; key?: string; keyBase64?: string; headers?: unknown; partition?: number }, execution: ToolExecution) =>
      run(args, { kind: 'produce', topic: args.topic,
        value: args.valueBase64 !== undefined ? { base64: args.valueBase64 } : args.value,
        ...(args.keyBase64 !== undefined ? { key: { base64: args.keyBase64 } } : args.key !== undefined ? { key: args.key } : {}),
        ...(args.partition !== undefined ? { partition: args.partition } : {}),
        ...(args.headers !== undefined ? { headers: asObject(args.headers, 'Headers') } : {}) }, execution) }))
  ctx.tools.register(defineTool({ name: 'kafka_produce_batch', description: '仅 SIT 顺序发布最多 10 条；部分成功和未知结果逐条回执，不自动重试。messages 是消息数组。',
    parameters: { ...required, topic: { type: 'string', required: true }, messages: { type: 'array', required: true, items: { type: 'object', additionalProperties: true }, description: '1 到 10 条消息。' } }, output,
    execute: (args: Selection & { topic?: string; messages?: unknown }, execution: ToolExecution) => {
      if (!Array.isArray(args.messages)) throw new Error('messages 必须是数组。')
      return run(args, { kind: 'produce-batch', topic: args.topic, messages: args.messages }, execution)
    } }))
  ctx.tools.register(defineTool({ name: 'kafka_tombstone', description: '仅 SIT 向 compact Topic 发布非空 Key 的 null Value 墓碑；压缩异步发生。',
    parameters: { ...required, topic: { type: 'string', required: true }, key: { type: 'string' }, keyBase64: { type: 'string' }, partition: { type: 'integer' } }, output,
    execute: (args: Selection & { topic?: string; key?: string; keyBase64?: string; partition?: number }, execution: ToolExecution) =>
      run(args, { kind: 'tombstone', topic: args.topic, key: args.keyBase64 !== undefined ? { base64: args.keyBase64 } : args.key,
        ...(args.partition !== undefined ? { partition: args.partition } : {}) }, execution) }))
  ctx.tools.register(defineTool({ name: 'kafka_create_topic', description: '仅 SIT 创建 dsh-test- 前缀测试 Topic。',
    parameters: { ...required, topic: { type: 'string', required: true }, partitions: { type: 'integer', required: true },
      replicationFactor: { type: 'integer', required: true }, cleanupPolicy: { type: 'string', required: true } }, output,
    execute: (args: Selection & { topic?: string; partitions?: number; replicationFactor?: number; cleanupPolicy?: string }, execution: ToolExecution) =>
      run(args, { kind: 'create-topic', topic: args.topic, partitions: args.partitions, replicationFactor: args.replicationFactor,
        cleanupPolicy: args.cleanupPolicy }, execution) }))
  ctx.tools.register(defineTool({ name: 'kafka_set_group_offsets', description: '仅 SIT 调整无运行成员消费组的指定分区位点。spec 含 groupId、topic、expected 及 offsets 或 timestamp/partitions；会检查旧值和回读。',
    parameters: { ...required, spec: { type: 'object', required: true, additionalProperties: true, description: '含 groupId、topic、expected，以及 offsets 或 timestamp 与 partitions。' } }, output,
    execute: (args: Selection & { spec?: unknown }, execution: ToolExecution) =>
      run(args, { ...asObject(args.spec, '位点调整'), kind: 'set-group-offsets' }, execution) }))
}

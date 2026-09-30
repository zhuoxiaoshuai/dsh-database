import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ConnectionService } from '../../connection-service.ts'
import type { ExecutionStore } from '../../execution-store.ts'
import { sanitizeToolError } from '../../ai-redaction.ts'
import { formatKafkaCommand, parseKafkaCommand } from './command.mjs'

type ToolExecution = { callId?: string; rootCallId?: string; signal?: AbortSignal; agent?: { session?: { id?: string } } }
type Selection = { connectionId?: string; generation?: string }
const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }

export function registerKafkaAiTools(ctx: { tools: { register(tool: unknown): void } }, service: ConnectionService,
  executions: ExecutionStore, validOwner: (id: string) => boolean): void {
  const owner = (execution: ToolExecution) => {
    const id = execution.agent?.session?.id || ''
    if (!validOwner(id)) throw new Error('当前工具调用缺少有效对话身份。')
    return id
  }
  const selected = (session: string, args: Selection) => {
    if (typeof args.connectionId !== 'string' || typeof args.generation !== 'string') throw new Error('请提供 connectionId 和 generation。')
    const connection = service.list(session).find(item => item.id === args.connectionId)
    if (!connection || connection.dialect !== 'kafka' || !connection.live || connection.generation !== args.generation) throw new Error('Kafka 连接已变化，请刷新。')
    return connection
  }
  const run = async (args: Selection, operation: Record<string, unknown>, execution: ToolExecution) => {
    const session = owner(execution)
    const connection = selected(session, args)
    const command = formatKafkaCommand(operation)
    parseKafkaCommand(command)
    const before = service.getExecutionDocument(session, connection.id, connection.generation)
    if (before.controller !== 'ai') throw new Error('用户已接管 AI Query，无法继续操作 Kafka。')
    const published = service.updateExecutionDocument(session, connection.id, command, 'ai', before.revision, connection.generation)
    const current = service.getExecutionDocument(session, connection.id, connection.generation)
    if (current.controller !== 'ai' || current.revision !== published.revision || current.text !== command) throw new Error('AI Query 已被修改，操作没有执行。')
    try {
      const result = await service.executeText(session, connection.id, connection.generation, command, execution.signal, 'ai', execution.callId, published.revision, execution.rootCallId)
      executions.emitWorkbench(session, { type: 'EXECUTION_FINISHED', connectionId: connection.id,
        generation: connection.generation, executionId: String(result.executionId || ''),
        queryRevision: published.revision, status: result.executionStatus === 'failed' ? 'failed' : result.executionStatus === 'cancelled' ? 'cancelled' : 'succeeded', sourceResult: result })
      return JSON.stringify(result)
    } catch (error) {
      throw new Error(sanitizeToolError(error instanceof Error ? error.message : 'Kafka 读取失败。'))
    }
  }
  ctx.tools.register(defineTool({
    name: 'kafka_status', description: '查看当前对话可用的 Kafka 连接、健康状态及连接代次。', parameters: {}, output,
    async execute(_args: unknown, execution: ToolExecution) {
      const session = owner(execution)
      await service.restoreRemembered(session)
      const record = executions.create({ conversationId: session, operation: 'kafka_status', initiator: 'ai', type: 'tool',
        callId: execution.callId, rootCallId: execution.rootCallId, title: '查看 Kafka 连接', historyVisible: true })
      const connections = service.list(session).filter(item => item.dialect === 'kafka').map(item => ({
        connectionId: item.id, generation: item.generation, name: item.name, environment: item.environment,
        live: item.live, health: item.health, version: item.version,
      }))
      executions.complete(record.executionId, 'succeeded', `可用连接 ${connections.length} 个。`)
      return JSON.stringify({ executionId: record.executionId, connections })
    },
  }))
  const required = { connectionId: { type: 'string' as const, required: true as const }, generation: { type: 'string' as const, required: true as const } }
  ctx.tools.register(defineTool({
    name: 'kafka_topics', description: '列出当前 Kafka 集群中账号可见的 Topic，最多返回一页。', parameters: required, output,
    execute: (args: Selection, execution: ToolExecution) => run(args, { kind: 'topics' }, execution),
  }))
  ctx.tools.register(defineTool({
    name: 'kafka_describe', description: '查看一个 Topic 的分区、Leader、水位和副本。', parameters: { ...required, topic: { type: 'string', required: true } }, output,
    execute: (args: Selection & { topic?: string }, execution: ToolExecution) => run(args, { kind: 'describe', topic: args.topic }, execution),
  }))
  ctx.tools.register(defineTool({
    name: 'kafka_peek', description: '只读、限量读取单个 Topic 的单个分区；不会提交业务消费位置。', parameters: {
      ...required, topic: { type: 'string', required: true }, partition: { type: 'integer', required: true },
      from: { type: 'string', required: true }, offset: { type: 'string' }, limit: { type: 'integer' },
    }, output,
    execute: (args: Selection & { topic?: string; partition?: number; from?: string; offset?: string; limit?: number }, execution: ToolExecution) =>
      run(args, { kind: 'peek', topic: args.topic, partition: args.partition, from: args.from, offset: args.offset, limit: args.limit }, execution),
  }))
}

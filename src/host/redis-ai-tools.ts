import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ConnectionService } from './connection-service.ts'
import type { ExecutionStore } from './execution-store.ts'
import { authorizeRedisCommand } from './redis-policy.ts'
import { sanitizeToolError } from './ai-redaction.ts'
import { createHash } from 'node:crypto'
import { redisLivePreview } from './redis-live-preview.ts'

type ToolExecution = { callId?: string; rootCallId?: string; signal?: AbortSignal; agent?: { session?: { id?: string } } }

export function registerRedisAiTools(ctx: { tools: { register(tool: unknown): void } }, service: ConnectionService, executions: ExecutionStore, validOwner: (id: string) => boolean): void {
  const owner = (execution: ToolExecution) => {
    const id = execution.agent?.session?.id || ''
    if (!validOwner(id)) throw new Error('当前工具调用缺少有效对话身份。')
    return id
  }
  const selected = (session: string, connectionId: unknown, generation: unknown) => {
    if (typeof connectionId !== 'string' || typeof generation !== 'string') throw new Error('请提供 connectionId 和 generation。')
    const connection = service.list(session).find(item => item.id === connectionId)
    if (!connection || connection.dialect !== 'redis' || !connection.live || connection.generation !== generation) throw new Error('Redis 连接已变化，请刷新。')
    return connection
  }
  const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
  const run = async (operation: 'redis_keys' | 'redis_value' | 'redis_execute', args: Record<string, unknown>, execution: ToolExecution, action: 'redis-scan' | 'redis-key' | 'redis-command', input: Record<string, unknown>) => {
    const session = owner(execution)
    const connection = selected(session, args.connectionId, args.generation)
    const document = service.getExecutionDocument(session, connection.id)
    if (document.controller !== 'ai') throw new Error('用户已接管 AI Query，无法继续操作 Redis。')
    if (operation === 'redis_execute' && connection.environment !== 'sit') throw new Error('UAT／PVT 的 AI 不开放任意 Redis 命令。')
    const commandName = operation === 'redis_execute' ? authorizeRedisCommand(String(input.command || ''))[0].toUpperCase() : operation === 'redis_keys' ? 'SCAN' : 'READ'
    // Publish executable text before dispatch. A concurrent human edit or takeover wins.
    const published = operation === 'redis_execute' ? service.updateExecutionDocument(session, connection.id, String(input.command || ''), 'ai', document.revision) : undefined
    const target = operation === 'redis_value' && typeof input.key === 'string' ? createHash('sha256').update(input.key).digest('hex').slice(0, 12) : ''
    const record = executions.create({
      conversationId: session, callId: execution.callId, rootCallId: execution.rootCallId,
      connectionId: connection.id, generation: connection.generation, connectionName: connection.name,
      dialect: 'redis', environment: connection.environment, operation, initiator: 'ai', type: 'tool', historyVisible: true,
      title: `Redis ${commandName}${target ? ` · Key ${target}` : ''}`,
    })
    const controller = new AbortController()
    if (execution.signal?.aborted) controller.abort()
    else execution.signal?.addEventListener('abort', () => controller.abort(), { once: true })
    executions.attachAbort(record.executionId, controller)
    executions.transition(record.executionId, 'running')
    executions.event(record.executionId, 'dispatched')
    try {
      const result = await service.redisRequest(session, connection.id, connection.generation, action, input, controller.signal, 'ai', published ? { queryRevision: published.revision, context: published.context } : undefined)
      executions.complete(record.executionId, result.failed === true ? 'failed' : 'succeeded', result.failed === true ? `${commandName} 返回 Redis 错误。` : `${commandName} 完成。`)
      if (published) executions.emitWorkbench(session, { type: 'EXECUTION_FINISHED', connectionId: connection.id,
        generation: connection.generation, executionId: record.executionId,
        queryRevision: published.revision, status: result.failed === true ? 'failed' : 'succeeded', sourceResult: redisLivePreview(result) })
      return JSON.stringify({ executionId: record.executionId, ...result })
    } catch (error) {
      const message = sanitizeToolError(error instanceof Error ? error.message : 'Redis 操作失败。')
      const uncertain = /未知|超时|已取消|已关闭|断开/.test(message) && operation === 'redis_execute'
      executions.complete(record.executionId, uncertain ? 'unknown' : 'failed', uncertain ? 'Redis 命令结果未知，请核验。' : 'Redis 操作失败。')
      throw new Error(message)
    }
  }

  ctx.tools.register(defineTool({
    name: 'redis_status', description: '查看当前对话可用的 Redis 连接及代次。', parameters: {}, output,
    async execute(_args: unknown, execution: ToolExecution) {
      const session = owner(execution)
      await service.restoreRemembered(session)
      const connections = service.list(session).filter(item => item.dialect === 'redis').map(item => ({
        connectionId: item.id, generation: item.generation, name: item.name, environment: item.environment,
        database: item.database, live: item.live, health: item.health, version: item.version,
      }))
      return JSON.stringify({ connections })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'redis_keys', description: '使用 SCAN 按游标读取 Redis Key。空页和重复 Key 均可能出现。',
    parameters: { connectionId: { type: 'string', required: true }, generation: { type: 'string', required: true }, cursor: { type: 'string' }, match: { type: 'string' } }, output,
    async execute(args: { connectionId?: string; generation?: string; cursor?: string; match?: string }, execution: ToolExecution) {
      return run('redis_keys', args, execution, 'redis-scan', { cursor: args.cursor || '0', match: args.match || '*' })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'redis_value', description: '只读查看一个 Redis Key 的类型、TTL 和分页值。',
    parameters: { connectionId: { type: 'string', required: true }, generation: { type: 'string', required: true }, key: { type: 'string', required: true }, cursor: { type: 'string' }, offset: { type: 'integer' } }, output,
    async execute(args: { connectionId?: string; generation?: string; key?: string; cursor?: string; offset?: number }, execution: ToolExecution) {
      return run('redis_value', args, execution, 'redis-key', { operation: 'read', key: args.key, cursor: args.cursor || '0', offset: args.offset || 0 })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'redis_execute', description: '仅 SIT Redis 连接可执行任意单条命令；UAT/PVT 会拒绝。应用黑名单默认空，Redis ACL 决定账号权限。',
    parameters: { connectionId: { type: 'string', required: true }, generation: { type: 'string', required: true }, command: { type: 'string', required: true } }, output,
    async execute(args: { connectionId?: string; generation?: string; command?: string }, execution: ToolExecution) {
      return run('redis_execute', args, execution, 'redis-command', { command: args.command })
    },
  }))
}

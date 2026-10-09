import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ConnectionService } from './connection-service.ts'
import type { ExecutionStore } from './execution-store.ts'
import { authorizeRedisCommand } from './redis-policy.ts'
import { nativeErrorText } from './connect-error.mjs'
import { resolveAiConnection } from './ai-connection-resolve.ts'

type ToolExecution = { callId?: string; rootCallId?: string; signal?: AbortSignal; agent?: { session?: { id?: string } } }

export function registerRedisAiTools(ctx: { tools: { register(tool: unknown): void } }, service: ConnectionService, _executions: ExecutionStore, validOwner: (id: string) => boolean): void {
  const owner = (execution: ToolExecution) => {
    const id = execution.agent?.session?.id || ''
    if (!validOwner(id)) throw new Error('当前工具调用缺少有效对话身份。')
    return id
  }
  const selected = (session: string, connectionId: unknown, generation: unknown) => resolveAiConnection({
    connections: service.list(session),
    family: 'redis',
    connectionId,
    generation,
  })
  const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
  const handle = {
    connectionId: { type: 'string' as const, description: '来自 redis_status.connections。唯一已登录连接可省略。' },
    generation: { type: 'string' as const, description: '来自 redis_status.connections。省略则用当前 generation。' },
  }
  const run = async (operation: 'redis_keys' | 'redis_value' | 'redis_execute', args: Record<string, unknown>, execution: ToolExecution, input: Record<string, unknown>) => {
    const session = owner(execution)
    const resolved = selected(session, args.connectionId, args.generation)
    if (!resolved.ok) return JSON.stringify(resolved)
    const connection = resolved.connection
    const document = service.getExecutionDocument(session, connection.id)
    if (document.controller !== 'ai') throw new Error('用户已接管 AI Query，无法继续操作 Redis。')
    if (operation === 'redis_execute' && connection.environment !== 'sit') throw new Error('UAT／PVT 的 AI 不开放任意 Redis 命令。')
    if (operation === 'redis_execute') {
      authorizeRedisCommand(String(input.command || ''))
      const published = service.updateExecutionDocument(session, connection.id, String(input.command || ''), 'ai', document.revision, connection.generation)
      try {
        const result = await service.executeText(session, connection.id, connection.generation, published.text,
          execution.signal, 'ai', execution.callId, published.revision, execution.rootCallId, published.context, { type: 'tool' })
        return JSON.stringify(result)
      } catch (error) {
        if (error instanceof Error) throw error
        throw new Error(nativeErrorText(error, 'Redis 命令失败。'))
      }
    }
    try {
      return JSON.stringify(await service.executeRedisReadTool(session, connection.id, connection.generation, operation, input,
        execution.signal, execution.callId, execution.rootCallId))
    } catch (error) {
      if (error instanceof Error) throw error
      throw new Error(nativeErrorText(error, 'Redis 操作失败。'))
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
      return JSON.stringify({
        connections,
        help: '先用返回的 connectionId 和 generation 调 redis_keys 或 redis_value。唯一已登录连接可省略这两个参数。',
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'redis_keys', description: '使用 SCAN 按游标读取 Redis Key。空页和重复 Key 均可能出现。',
    parameters: { ...handle, cursor: { type: 'string' }, match: { type: 'string' } }, output,
    async execute(args: { connectionId?: string; generation?: string; cursor?: string; match?: string }, execution: ToolExecution) {
      return run('redis_keys', args, execution, { cursor: args.cursor || '0', match: args.match || '*' })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'redis_value', description: '只读查看一个 Redis Key 的类型、TTL 和分页值。',
    parameters: { ...handle, key: { type: 'string', required: true }, cursor: { type: 'string' }, offset: { type: 'integer' } }, output,
    async execute(args: { connectionId?: string; generation?: string; key?: string; cursor?: string; offset?: number }, execution: ToolExecution) {
      return run('redis_value', args, execution, { operation: 'read', key: args.key, cursor: args.cursor || '0', offset: args.offset || 0 })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'redis_execute', description: '仅 SIT Redis 连接可执行任意单条命令；UAT/PVT 会拒绝。应用黑名单默认空，Redis ACL 决定账号权限。',
    parameters: { ...handle, command: { type: 'string', required: true } }, output,
    async execute(args: { connectionId?: string; generation?: string; command?: string }, execution: ToolExecution) {
      return run('redis_execute', args, execution, { command: args.command })
    },
  }))
}

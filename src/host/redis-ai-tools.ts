import {toolOwner, type ToolExecution} from './ai-tool-context.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { RedisAiPort } from './ai-service-ports.ts'
import type { ExecutionStore } from './execution-store.ts'
import { authorizeRedisCommand } from './redis-policy.ts'
import { nativeErrorText } from './connect-error.mjs'
import { resolveAiConnection } from './ai-connection-resolve.ts'
import { displayBytes, isBytesString } from '../shared/redis-bytes.ts'

/** Key 在 host 内部是 latin1 字节串；给模型看的一律转成 \xNN 展示串，便于其原样回传。 */
function readableKeys(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(readableKeys)
  const record = value as Record<string, unknown>
  const next: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    if ((key === 'keys' && Array.isArray(item))) next[key] = item.map(name => typeof name === 'string' ? displayBytes(name) : name)
    else if (key === 'key' && typeof item === 'string') next[key] = isBytesString(item) ? displayBytes(item) : item
    else next[key] = readableKeys(item)
  }
  return next
}


export function registerRedisAiTools(ctx: { tools: { register(tool: unknown): void } }, service: RedisAiPort, _executions: ExecutionStore, validOwner: (id: string) => boolean): void {
  const owner = (execution:ToolExecution) => toolOwner(execution,validOwner)
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
      return JSON.stringify(readableKeys(await service.executeRedisReadTool(session, connection.id, connection.generation, operation, input,
        execution.signal, execution.callId, execution.rootCallId)))
    } catch (error) {
      if (error instanceof Error) throw error
      throw new Error(nativeErrorText(error, 'Redis 操作失败。'))
    }
  }

  ctx.tools.register(defineTool({
    name: 'redis_status', description: '先调本工具取 connectionId。缓存、键用 redis_*。', parameters: {}, output,
    async execute(_args: unknown, execution: ToolExecution) {
      const session = owner(execution)
      await service.restoreRemembered(session)
      const connections = service.list(session).filter(item => item.dialect === 'redis').map(item => ({
        connectionId: item.id, generation: item.generation, name: item.name, environment: item.environment,
        database: item.database, live: item.live, health: item.health, version: item.version,
      }))
      const live = connections.filter(item => item.live)
      return JSON.stringify({
        connections,
        help: '先用返回的 connectionId 和 generation 调 redis_keys。唯一已登录连接可省略这两个参数。',
        next: live.map(item => ({ tool: 'redis_keys', args: { connectionId: item.connectionId, generation: item.generation } })),
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'redis_keys', description: '缓存、键。SCAN 游标读 Redis Key。空页和重复 Key 均可能出现。',
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

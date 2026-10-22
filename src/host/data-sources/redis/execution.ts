import { parseRedisCommandArgs } from '../../../shared/redis-command.ts'
import { authorizeRedisCommand } from '../../redis-policy.ts'
import { assertRedisDatabaseId, assertRedisClusterDatabase } from '../../redis-request.ts'
import { redisLivePreview } from '../../redis-live-preview.ts'
import type { Connection } from '../../../shared/workbench.ts'
import type { PreparedTextOperation } from '../module-types.ts'

export const redisExecution = {
  normalizeContext(raw: unknown, binding: Connection): Record<string, string> {
    if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'database'))) throw new Error('Redis 执行目标无效。')
    const database = assertRedisDatabaseId(String((raw as { database?: unknown } | undefined)?.database ?? binding.database ?? '0'))
    assertRedisClusterDatabase(database, binding.settings && 'redisMode' in binding.settings ? binding.settings.redisMode : undefined)
    return { database }
  },
  prepareText(text: unknown, context: Record<string, string>): PreparedTextOperation {
    const parsed = parseRedisCommandArgs(String(text || ''))
    const args = parsed.map(arg => arg.value)
    // bytes 标记随命令下发：带 \xNN 的参数在发送边界还原成 Buffer，其余仍按 UTF-8 文本。
    const bytes = parsed.map(arg => arg.bytes)
    const name = args[0].toUpperCase()
    return { sourceKind: 'redis', action: 'redis-command', text: String(text), input: { args, bytes, database: context.database }, operation: 'redis_execute', title: `Redis ${name}`,
      recordPolicy: 'owned',
      summarize: result => result.failed === true ? `Redis ${name} 返回错误。` : `Redis ${name} 已完成。`,
      classifyResult: result => result.failed === true ? 'failed' : 'succeeded',
      classifyInterruption: (_error, state) => state.dispatched ? 'unknown' : state.aborted ? 'cancelled' : 'failed',
      completedResultIsDefinitive: true,
      projectLiveResult: result => ({ ...redisLivePreview(result), executionStatus: result.executionStatus }) }
  },
  authorize(prepared: PreparedTextOperation, actor: 'user' | 'ai', binding: Connection): void {
    prepared.queue = actor === 'ai' ? 'ai' : 'manual'
    if (actor !== 'user' && actor !== 'ai') throw new Error('执行身份无效。')
    if (actor === 'ai' && binding.environment !== 'sit') throw new Error('UAT／PVT 的 AI 不开放任意 Redis 命令。')
    const args = authorizeRedisCommand(prepared.text)
    const flags = parseRedisCommandArgs(prepared.text).map(arg => arg.bytes)
    if (prepared.action !== 'redis-command' || JSON.stringify(args) !== JSON.stringify(prepared.input.args) || JSON.stringify(flags) !== JSON.stringify(prepared.input.bytes)) throw new Error('Redis 命令授权无效。')
  },
}

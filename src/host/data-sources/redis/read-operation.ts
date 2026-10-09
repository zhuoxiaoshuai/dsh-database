import { createHash } from 'node:crypto'
import { nativeErrorText } from '../../connect-error.mjs'
import { redisExecution } from './execution.ts'
import type { Connection } from '../../../shared/workbench.ts'
import type { OperationStatus } from '../../operation-runtime.ts'

export type RedisReadTool = 'redis_keys' | 'redis_value'

/** Structured AI reads only; Key mutations and text commands use their own paths. */
export function prepareRedisReadOperation(operation: RedisReadTool, input: Record<string, unknown>, rawContext: unknown, binding: Connection) {
  if (operation !== 'redis_keys' && operation !== 'redis_value') throw new Error('此 Redis 读取工具尚未开放。')
  if (input.operation !== undefined && input.operation !== 'read') throw new Error('此入口只允许 Redis 读取。')
  const context = redisExecution.normalizeContext(rawContext, binding)
  if (operation === 'redis_value' && typeof input.key !== 'string') throw new Error('请提供 Redis Key。')
  const commandName = operation === 'redis_keys' ? 'SCAN' : 'READ'
  const target = operation === 'redis_value' ? createHash('sha256').update(input.key as string).digest('hex').slice(0, 12) : ''
  return {
    action: operation === 'redis_keys' ? 'redis-scan' as const : 'redis-key' as const,
    input: operation === 'redis_keys'
      ? { cursor: input.cursor || '0', match: input.match || '*', database: context.database }
      : { operation: 'read', key: input.key, cursor: input.cursor || '0', offset: input.offset || 0, database: context.database },
    context,
    title: `Redis ${commandName}${target ? ` · Key ${target}` : ''}`,
    summarize: (result: Record<string, unknown>) => result.failed === true ? `${commandName} 返回 Redis 错误。` : `${commandName} 完成。`,
    classifyResult: (result: Record<string, unknown>): OperationStatus => result.failed === true ? 'failed' : 'succeeded',
    summarizeFailure: (error: unknown, _lifecycle: unknown, status: OperationStatus) => status === 'cancelled'
      ? `Redis ${commandName} 读取已取消。` : status === 'unknown' ? `Redis ${commandName} 读取结果未知。` : nativeErrorText(error, `Redis ${commandName} 读取失败。`),
  }
}

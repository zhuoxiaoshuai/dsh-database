import type { ExecutionDocument } from '../shared/execution-document.ts'
import type { ExecutionStore } from './execution-store.ts'
import { runOperation, type OperationBinding } from './operation-runtime.ts'
import { authorizeRedisCommand } from './redis-policy.ts'

const REDIS_DB = /^(0|[1-9]\d{0,4})$/

export function assertRedisDatabaseId(database: string): string {
  if (!REDIS_DB.test(database) || Number(database) > 65535) throw new Error('Redis DB 编号必须为 0–65535。')
  return database
}

export function assertRedisClusterDatabase(database: string | undefined, mode: unknown): void {
  if (mode === 'cluster' && database !== undefined && database !== '' && database !== '0') throw new Error('Redis 集群只使用 DB 0。')
}

type RedisAction = 'redis-command' | 'redis-scan' | 'redis-key-suggest' | 'redis-key'
type RedisInput = {
  command?: string
  cursor?: string
  match?: string
  prefix?: string
  database?: string
  [key: string]: unknown
}

/** 已校验的库号随请求交给 worker。redis-command 不再只留 args。 */
export function redisPreparedInput(action: RedisAction, input: RedisInput, database: string | undefined): Record<string, unknown> {
  const scope = database === undefined || database === '' ? {} : { database: assertRedisDatabaseId(database) }
  if (action === 'redis-command') return { args: authorizeRedisCommand(String(input.command || '')), ...scope }
  if (action === 'redis-scan') return { cursor: input.cursor, match: input.match, ...scope }
  if (action === 'redis-key-suggest') return { prefix: input.prefix, ...scope }
  const { command: _command, args: _args, ...rest } = input
  return { ...rest, ...scope }
}

/** 发布或接管之后、真正发出之前再核对。对不上就拒绝，命令不出去。 */
export function redisAiDispatchAllowed(document: ExecutionDocument, revision: number, text: string): void {
  if (document.controller !== 'ai' || document.revision !== revision || document.text !== text) {
    throw new Error('AI Query 已被人工修改或接管，操作没有发出。')
  }
}

/** 人工命令台记一笔。AI 工具和文档执行自己已有记录，scan/key 不记。 */
export function redisCommandRecordsHistory(action: string, initiator: 'user' | 'ai', record?: boolean): boolean {
  return record !== false && action === 'redis-command' && initiator === 'user'
}

export function recordUserRedisCommand<T extends Record<string, unknown>>(
  executions: ExecutionStore | undefined,
  binding: OperationBinding,
  commandName: string,
  work: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T & { executionId?: string; executionStatus: 'succeeded' | 'failed' | 'cancelled' }> {
  return runOperation(executions, binding, {
    operation: 'redis_execute', title: `Redis ${commandName}`, initiator: 'user',
  }, work,
  result => result.failed === true ? `Redis ${commandName} 返回错误。` : `Redis ${commandName} 已完成。`,
  signal,
  result => result.failed === true ? 'failed' : 'succeeded')
}

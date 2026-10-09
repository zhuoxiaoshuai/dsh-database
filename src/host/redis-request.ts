
const REDIS_DB = /^(0|[1-9]\d{0,4})$/

export function assertRedisDatabaseId(database: string): string {
  if (!REDIS_DB.test(database) || Number(database) > 65535) throw new Error('Redis DB 编号必须为 0–65535。')
  return database
}

export function assertRedisClusterDatabase(database: string | undefined, mode: unknown): void {
  if (mode === 'cluster' && database !== undefined && database !== '' && database !== '0') throw new Error('Redis 集群只使用 DB 0。')
}

type RedisAction = 'redis-scan' | 'redis-key-suggest' | 'redis-key'
type RedisInput = {
  command?: string
  cursor?: string
  match?: string
  prefix?: string
  database?: string
  [key: string]: unknown
}

/** 结构化浏览请求保留已校验的目标库号。命令由标准文本入口处理。 */
export function redisPreparedInput(action: RedisAction, input: RedisInput, database: string | undefined): Record<string, unknown> {
  const scope = database === undefined || database === '' ? {} : { database: assertRedisDatabaseId(database) }
  if (action === 'redis-scan') return { cursor: input.cursor, match: input.match, ...scope }
  if (action === 'redis-key-suggest') return { prefix: input.prefix, ...scope }
  const { command: _command, args: _args, ...rest } = input
  return { ...rest, ...scope }
}

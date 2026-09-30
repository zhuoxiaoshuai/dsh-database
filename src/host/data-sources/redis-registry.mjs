import { redisProvider } from './redis/index.mjs'

export function getRedisDataSource(id) {
  if (id !== redisProvider.id) throw new Error(`不是 Redis 数据源：${String(id || '')}`)
  return redisProvider
}

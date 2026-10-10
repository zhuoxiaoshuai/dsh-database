import {createDataSourceRegistry} from './provider-registry.mjs'
import { redisProvider } from './redis/index.mjs'

const registry = createDataSourceRegistry([redisProvider])
export function getRedisDataSource(id) {
  if (id !== redisProvider.id) throw new Error(`不是 Redis 数据源：${String(id || '')}`)
  return registry.get(id)
}

import { mysqlSource } from './mysql.ts'
import { oracleSource } from './oracle.ts'
import { redisSource } from './redis.ts'
import { kafkaSource } from './kafka.ts'
import type { DataSourceId, SqlClientDescriptor, SqlDataSourceId, RedisClientDescriptor, KafkaClientDescriptor } from './types.ts'

const sources: ReadonlyMap<SqlDataSourceId, SqlClientDescriptor> = new Map([
  [mysqlSource.id, mysqlSource],
  [oracleSource.id, oracleSource],
])
export function createClientSourceRegistry<Id extends string, Source extends { id: Id; displayName: string; family: string; connection?: {
  validateConnectionTarget: Function; connectionExtras: Function; connectionFingerprintSuffix: Function
} }>(entries: readonly Source[], expectedIds: readonly Id[]) {
  const expected = new Set(expectedIds)
  const byId = new Map<Id, Source>()
  if (expected.size !== expectedIds.length) throw new Error('客户端数据源声明重复。')
  for (const source of entries) {
    if (!source || !expected.has(source.id) || byId.has(source.id) || !source.displayName
      || (!source.connection && source.family !== 'kafka')
      || (source.connection && (typeof source.connection.validateConnectionTarget !== 'function'
        || typeof source.connection.connectionExtras !== 'function'
        || typeof source.connection.connectionFingerprintSuffix !== 'function'))) throw new Error(`客户端数据源能力不完整或重复：${String(source?.id)}`)
    byId.set(source.id, source)
  }
  for (const id of expected) if (!byId.has(id)) throw new Error(`缺少客户端数据源：${id}`)
  return Object.freeze({ ids: () => [...byId.keys()], get(id: Id): Source {
    const source = byId.get(id)
    if (!source) throw new Error(`不支持此数据源：${String(id)}`)
    return source
  } })
}

const workspaceSources = createClientSourceRegistry<DataSourceId, SqlClientDescriptor | RedisClientDescriptor | KafkaClientDescriptor>([
  mysqlSource, oracleSource, redisSource, kafkaSource,
], ['mysql', 'oracle', 'redis', 'kafka'])

export const supportedDataSources = Object.freeze([...sources.keys()])
export const supportedAllDataSources = Object.freeze(workspaceSources.ids())
export const clientRedisSource = (): RedisClientDescriptor => redisSource
export function clientWorkspaceDescriptor(id: DataSourceId): SqlClientDescriptor | RedisClientDescriptor | KafkaClientDescriptor {
  return workspaceSources.get(id)
}
export const legacyDefaultDataSource: SqlDataSourceId = 'mysql'

export function isDataSourceId(value: unknown): value is DataSourceId {
  return typeof value === 'string' && supportedAllDataSources.includes(value as DataSourceId)
}

export function legacyDataSourceId(value: unknown): SqlDataSourceId {
  return value === 'mysql' || value === 'oracle' ? value : legacyDefaultDataSource
}

export function clientDataSource(id: SqlDataSourceId): SqlClientDescriptor {
  const source = sources.get(id)
  if (!source) throw new Error(`不支持此数据源：${String(id || '')}`)
  return source
}

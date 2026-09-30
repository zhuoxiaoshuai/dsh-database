import type { RedisClientDescriptor } from './types.ts'

/** Browser-safe display contract. No credentials, Node APIs, or driver imports. */
const REDIS_DB_ID = /^(0|[1-9]\d{0,4})$/

function redisSettingsMode(settings: unknown): string | undefined {
  if (!settings || typeof settings !== 'object' || !('redisMode' in settings)) return undefined
  return typeof settings.redisMode === 'string' ? settings.redisMode : undefined
}

export function redisDatabaseIds(connection: { database?: string; databases?: readonly string[]; settings?: unknown }): string[] {
  if (redisSettingsMode(connection.settings) === 'cluster') return ['0']
  const listed = (connection.databases || []).filter(id => REDIS_DB_ID.test(id) && Number(id) <= 65535)
  if (listed.length) return [...listed]
  const current = connection.database && REDIS_DB_ID.test(connection.database) && Number(connection.database) <= 65535 ? connection.database : '0'
  return [current]
}

export function redisDatabaseLabel(id: string): string {
  return `db${id}`
}

export function redisSelectedDatabase(connection: { database?: string; databases?: readonly string[]; settings?: unknown }, catalogRoot: string): string {
  return redisDatabaseIds(connection).includes(catalogRoot) ? catalogRoot : ''
}

/** 命令台和补全用的库。树没选中时回到建连主库。 */
export function redisCommandDatabase(connection: { database?: string; databases?: readonly string[]; settings?: unknown }, catalogRoot: string): string {
  return redisSelectedDatabase(connection, catalogRoot) || connection.database || '0'
}

export function redisConnectionMode(input: { redisMode?: unknown }): 'standalone' | 'sentinel' | 'cluster' {
  if (input.redisMode === undefined || input.redisMode === 'standalone') return 'standalone'
  if (input.redisMode === 'sentinel' || input.redisMode === 'cluster') return input.redisMode
  throw new Error('Redis 连接方式无效。')
}

export const redisSource: RedisClientDescriptor = Object.freeze({
  id: 'redis', family: 'redis', showsSchemaTree: false, displayName: 'Redis', badge: 'R', defaultPort: 6379,
  connection: {
    requiresUsername: false, requiresPassword: false,
    validateConnectionTarget(database: string, input: Record<string, unknown>) {
      const mode = redisConnectionMode(input)
      if (!/^(0|[1-9]\d{0,4})$/.test(database) || Number(database) > 65535) throw new Error('Redis DB 编号必须为 0–65535。')
      if (mode === 'cluster' && database !== '0') throw new Error('Redis 集群只使用 DB 0。')
      if (mode === 'sentinel' && (typeof input.sentinelMaster !== 'string' || input.sentinelMaster.length > 128 || !input.sentinelMaster.trim())) throw new Error('请填写 Master 名称。')
      if (input.tls !== undefined && typeof input.tls !== 'boolean') throw new Error('TLS 设置无效。')
      if (input.caPem !== undefined && (typeof input.caPem !== 'string' || input.caPem.length > 65536 || (input.caPem && !input.tls))) throw new Error('CA 证书设置无效。')
    },
    connectionExtras: (input: Record<string, unknown>) => {
      const mode = redisConnectionMode(input)
      return {
        tls: input.tls === true,
        ...(input.caPem ? { caPem: input.caPem as string } : {}),
        redisMode: mode,
        ...(mode === 'sentinel' ? { sentinelMaster: String(input.sentinelMaster).trim() } : {}),
      }
    },
    connectionFingerprintSuffix: (input: { tls?: boolean; redisMode?: 'standalone' | 'sentinel' | 'cluster'; sentinelMaster?: string }) => {
      const mode = input.redisMode === 'sentinel' || input.redisMode === 'cluster' ? input.redisMode : 'standalone'
      return [input.tls ? 'tls' : 'plain', mode, ...(mode === 'sentinel' ? [String(input.sentinelMaster || '').trim()] : [])]
    },
  },
  capabilities: Object.freeze({ command: true, scan: true, key: true }),
})

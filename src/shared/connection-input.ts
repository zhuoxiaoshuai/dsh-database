import type { ConnectionInput } from './workbench.ts'
import { normalizeEnvironment } from './connection-permission.ts'
import { clientWorkspaceDescriptor, isDataSourceId } from './data-sources/registry.ts'

export function validateConnection(value: unknown, options?: { passwordOptional?: boolean }): ConnectionInput {
  if (!value || typeof value !== 'object') throw new Error('请填写连接信息。')
  const v = value as Record<string, unknown>
  const str = (key: string, max: number) => { if (typeof v[key] !== 'string' || v[key].length > max) throw new Error('连接字段格式或长度不正确。'); return v[key] as string }
  const dialect = v.dialect
  if (!isDataSourceId(dialect) || dialect === 'kafka') throw new Error('请选择 MySQL、Oracle 或 Redis。')
  const source = clientWorkspaceDescriptor(dialect)
  if (source.family === 'kafka') throw new Error('Kafka 连接使用独立配置。')
  const host = str('host', 253).trim(), database = str('database', 128).trim(), username = str('username', 128).trim()
  const validHost = /^[a-zA-Z0-9._:\-]+$/.test(host) || /^\[(?=[^\]]*:)[0-9a-fA-F:.]+\]$/.test(host)
  if (!validHost || (source.connection.requiresUsername && !username) || !Number.isInteger(v.port) || Number(v.port) < 1 || Number(v.port) > 65535) throw new Error('请填写有效的主机、端口和用户名。')
  const environment = normalizeEnvironment(v.environment)
  source.connection.validateConnectionTarget(database, v)
  if (v.rememberPassword !== undefined && typeof v.rememberPassword !== 'boolean') throw new Error('记住密码选项不正确。')
  if (v.useSavedPassword !== undefined && typeof v.useSavedPassword !== 'boolean') throw new Error('已保存密码选项不正确。')
  const password = typeof v.password === 'string' && v.password.length <= 4096 ? v.password : ''
  if (passwordRequired(dialect) && !password && !v.useSavedPassword && !options?.passwordOptional) throw new Error('请输入密码。')
  return {
    name: str('name', 80).trim() || `${source.displayName} · ${host}:${v.port}`,
    dialect, host, port: Number(v.port), database, username, password,
    oracleMode: v.oracleMode === 'sid' ? 'sid' : 'service',
    ...source.connection.connectionExtras(v),
    environment,
    rememberPassword: v.rememberPassword === true,
    useSavedPassword: v.useSavedPassword === true,
  }
}

export function passwordRequired(dialect: string): boolean {
  const source = clientWorkspaceDescriptor(dialect as ConnectionInput['dialect'])
  return source.family !== 'kafka' && source.connection.requiresPassword
}

/** Reopen without the form when a password is stored, or when this source has no password. */
export function canReuseSavedLogin(connection: { dialect: string; hasPassword?: boolean }): boolean {
  return !!connection.hasPassword || !passwordRequired(connection.dialect)
}

/** 导入去重与 sameLogin 共用：有库名才把库名算进身份；Oracle 另含 service/SID；Redis 另含连接方式。 */
export function connectionFingerprint(input: {
  dialect: string
  host: string
  port: number
  database: string
  username: string
  oracleMode?: string
  tls?: boolean
  caPem?: string
  redisMode?: 'standalone' | 'sentinel' | 'cluster'
  sentinelMaster?: string
}): string {
  const host = String(input.host || '').trim().toLowerCase()
  const username = String(input.username || '').trim()
  const database = String(input.database || '').trim()
  const parts = [input.dialect, host, String(input.port), username]
  if (database) parts.push(database)
  const source = clientWorkspaceDescriptor(input.dialect as ConnectionInput['dialect'])
  if (source.family === 'kafka') throw new Error('Kafka 连接指纹必须由 Host 模块生成。')
  parts.push(...source.connection.connectionFingerprintSuffix(input))
  return parts.join('\0')
}

export type SqlDataSourceId = 'mysql' | 'oracle'
export type DataSourceId = SqlDataSourceId | 'redis' | 'kafka'

export interface SourceConnectionDescriptor {
  requiresUsername: boolean
  requiresPassword: boolean
  validateConnectionTarget(database: string, input: Record<string, unknown>): void
  connectionExtras(input: Record<string, unknown>): Record<string, unknown>
  connectionFingerprintSuffix(input: { oracleMode?: string; tls?: boolean; caPem?: string; redisMode?: 'standalone' | 'sentinel' | 'cluster'; sentinelMaster?: string }): string[]
}

export interface RedisClientDescriptor {
  connection: SourceConnectionDescriptor
  id: 'redis'
  family: 'redis'
  displayName: string
  badge: string
  defaultPort: number
  capabilities: { command: true; scan: true; key: true }
  showsSchemaTree: false
}
export interface KafkaClientDescriptor {
  id: 'kafka'
  family: 'kafka'
  displayName: string
  badge: string
  capabilities: { topics: true; describe: true; peek: true }
  showsSchemaTree: false
}

export interface SqlClientDescriptor {
  connection: SourceConnectionDescriptor
  id: SqlDataSourceId
  family: 'sql'
  showsSchemaTree: true
  displayName: string
  badge: string
  defaultPort: number
  namespaceLabel: string
  namespaceCaseInsensitive: boolean
  requiresServiceOrSid: boolean
  supportsShowIndex: boolean
  supportsColumnComment: boolean
  inlineColumnComment: boolean
  defaultColumnType: string
  defaultPrimaryKeyType: string
  identifierQuote: '`' | '"'
  pageClause(limit: number, offset: number): string
  formatterLanguage: 'mysql' | 'plsql'
  supportsQQuote: boolean
  supportsHashComment: boolean
  doubleDashNeedsSpace: boolean
  explainPrefix: string
  paginationKeywords: string[]
  validateTarget(database: string, oracleMode: unknown): void
  fingerprintSuffix(oracleMode?: string): string[]
  ownsSchema(connection: { database?: string; databases?: string[]; settings?: { username?: string } }, name: string): boolean
  pickDefaultSchema(names: string[], savedSchema?: string, database?: string, username?: string): string
}

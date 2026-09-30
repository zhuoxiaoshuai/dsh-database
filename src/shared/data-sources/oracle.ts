import type { SqlClientDescriptor } from './types.ts'
type SourceConnection = Parameters<SqlClientDescriptor['ownsSchema']>[0]

const systemSchemas = new Set(['mysql', 'information_schema', 'performance_schema', 'sys', 'sysaux', 'system', 'xdb', 'outln'])
const listed = (names: string[], value?: string) => {
  const needle = value?.trim().toLowerCase()
  return needle ? names.find(name => name.toLowerCase() === needle) || '' : ''
}

export const oracleSource: SqlClientDescriptor = Object.freeze({
  id: 'oracle', family: 'sql', showsSchemaTree: true, displayName: 'Oracle', badge: 'O', defaultPort: 1521,
  connection: {
    requiresUsername: true, requiresPassword: true,
    validateConnectionTarget(database: string, input: Record<string, unknown>) {
      if (!['service', 'sid'].includes(String(input.oracleMode)) || !/^[a-zA-Z0-9._$#-]+$/.test(database)) throw new Error('Oracle 需要有效的 Service Name 或 SID。')
    },
    connectionExtras: () => ({}),
    connectionFingerprintSuffix: (input: { oracleMode?: string }) => [input.oracleMode === 'sid' ? 'sid' : 'service'],
  },
  namespaceLabel: 'Schema', namespaceCaseInsensitive: true, requiresServiceOrSid: true,
  supportsShowIndex: false, supportsColumnComment: true, inlineColumnComment: false,
  defaultColumnType: 'VARCHAR2(255)', defaultPrimaryKeyType: 'NUMBER(19)', identifierQuote: '"',
  pageClause: (limit: number, offset: number) => `OFFSET ${offset} ROWS FETCH FIRST ${limit} ROWS ONLY`,
  formatterLanguage: 'plsql', supportsQQuote: true, supportsHashComment: false,
  doubleDashNeedsSpace: false, explainPrefix: 'EXPLAIN PLAN FOR',
  paginationKeywords: ['FETCH FIRST', 'OFFSET', 'ROWS'],
  validateTarget(database: string, oracleMode: unknown) {
    if (!['service', 'sid'].includes(String(oracleMode)) || !/^[a-zA-Z0-9._$#-]+$/.test(database)) {
      throw new Error('Oracle 需要有效的 Service Name 或 SID。')
    }
  },
  fingerprintSuffix: (mode?: string) => [mode === 'sid' ? 'sid' : 'service'],
  ownsSchema(connection: SourceConnection, name: string) {
    const needle = name.toLowerCase()
    if (connection.settings?.username?.trim().toLowerCase() === needle) return true
    if (connection.database?.toLowerCase() === needle) return true
    return connection.databases?.some(item => typeof item === 'string' && item.toLowerCase() === needle) || false
  },
  pickDefaultSchema(names: string[], savedSchema?: string, _database?: string, username?: string) {
    return listed(names, savedSchema) || listed(names, username)
      || names.find(name => !systemSchemas.has(name.toLowerCase())) || names[0] || ''
  },
})

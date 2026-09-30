import type { SqlClientDescriptor } from './types.ts'
type SourceConnection = Parameters<SqlClientDescriptor['ownsSchema']>[0]

const systemSchemas = new Set(['mysql', 'information_schema', 'performance_schema', 'sys', 'sysaux', 'system', 'xdb', 'outln'])
const alwaysVisible = new Set(['mysql', 'information_schema', 'performance_schema', 'sys'])
const listed = (names: string[], value?: string) => value && names.includes(value.trim()) ? value.trim() : ''

export const mysqlSource: SqlClientDescriptor = Object.freeze({
  id: 'mysql', family: 'sql', showsSchemaTree: true, displayName: 'MySQL', badge: 'M', defaultPort: 3306,
  connection: { requiresUsername: true, requiresPassword: true, validateConnectionTarget() {}, connectionExtras: () => ({}), connectionFingerprintSuffix: () => [] },
  namespaceLabel: '数据库', namespaceCaseInsensitive: false, requiresServiceOrSid: false,
  supportsShowIndex: true, supportsColumnComment: false, inlineColumnComment: true,
  defaultColumnType: 'VARCHAR(255)', defaultPrimaryKeyType: 'BIGINT', identifierQuote: '`',
  pageClause: (limit: number, offset: number) => `LIMIT ${limit} OFFSET ${offset}`,
  formatterLanguage: 'mysql', supportsQQuote: false, supportsHashComment: true,
  doubleDashNeedsSpace: true, explainPrefix: 'EXPLAIN', paginationKeywords: ['LIMIT'],
  validateTarget() {},
  fingerprintSuffix: () => [],
  ownsSchema(connection: SourceConnection, name: string) {
    if (alwaysVisible.has(name.toLowerCase()) || connection.database === name) return true
    return connection.databases?.includes(name) || false
  },
  pickDefaultSchema(names: string[], savedSchema?: string, database?: string) {
    return listed(names, savedSchema) || listed(names, database)
      || names.find(name => !systemSchemas.has(name.toLowerCase())) || names[0] || ''
  },
})

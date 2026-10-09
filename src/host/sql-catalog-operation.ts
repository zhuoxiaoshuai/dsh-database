import { catalogStatement, visibleCatalogSql } from './catalog.mjs'
import { executionStop, isHostQueryTimeout } from '../shared/execution.ts'
import { dialectCapabilities } from '../shared/dialect-capabilities.ts'
import { draftSelects, quoteIdentifier, type CatalogRequest, type CatalogResult, type Connection, type SqlDialect } from '../shared/workbench.ts'
import type { OperationLifecycle, OperationMetadata, OperationStatus } from './operation-runtime.ts'

export type CatalogToolInput = { kind?: string; schema?: string; table?: string; search?: string; offset?: number }
export type CatalogToolOutcome = { value: Record<string, unknown>; status: 'succeeded' | 'failed'; message?: string; conclusion: string }
const SYSTEM_SCHEMA = /^(information_schema|mysql|performance_schema|sys|sysaux|system)$/i
const clipName = (value: unknown, max = 40) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}
const queryDraft = (sql?: string) => sql?.trim() ? { kind: 'query', sql } : undefined

export function prepareCatalogTool(connection: Connection & { dialect: SqlDialect }, args: CatalogToolInput) {
  args = { ...args }
  const kind = args.kind
  if (kind !== 'schemas' && kind !== 'tables' && kind !== 'table') throw new Error('kind 须为 schemas、tables 或 table。')
  if ((kind === 'tables' || kind === 'table') && !args.schema) throw new Error('请提供 schema。')
  if (kind === 'table' && !args.table) throw new Error('请提供 table。')
  const input: CatalogRequest = kind === 'schemas' ? { kind, offset: args.offset || 0 }
    : kind === 'tables' ? { kind, schema: args.schema || '', search: args.search, offset: args.offset || 0 }
    : { kind, schema: args.schema || '', table: args.table || '' }
  const title = kind === 'schemas' ? `列出 ${clipName(connection.name)} 的数据库，确认可见库和表数量`
    : kind === 'tables' ? (args.search ? `查找 ${clipName(args.schema)} 中匹配“${clipName(args.search, 24)}”的表，定位业务表` : `查找 ${clipName(args.schema)} 中的表，确认有哪些业务表`)
    : `查看 ${clipName(args.schema)}.${clipName(args.table)} 的结构，确认字段后再写查询`
  const reason = kind === 'schemas' ? '为确认可见 Schema 和表数量。'
    : kind === 'tables' ? (args.search ? `按名称或字段匹配“${clipName(args.search, 24)}”，定位可用业务表。` : `浏览 ${clipName(args.schema)} 的表和视图，便于后续查询。`)
    : '为确认字段、索引和约束后再写查询。'
  const metadata: OperationMetadata = { operation: 'database_catalog', type: 'catalog', historyVisible: false, initiator: 'ai', title, reason,
    schema: kind === 'schemas' ? undefined : args.schema, tables: kind === 'table' ? [args.table!] : undefined }
  const dialect = connection.dialect
  const statement = catalogStatement(dialect, input)
  const sql = visibleCatalogSql(statement)
  const draftFor = (result?: CatalogResult) => {
    if (kind === 'table') return queryDraft(draftSelects(dialect, args.schema || '', [args.table || '']))
    if (kind === 'tables') {
      if (!result) return undefined
      const names = (result.items || []).map(item => String(item.name || '')).filter(Boolean)
      return queryDraft(draftSelects(dialect, args.schema || '', names.length ? names : ['请填写表名']))
    }
    const rows = (result?.items || []).filter(item => !SYSTEM_SCHEMA.test(String(item.name || '')))
    if (!rows.length) return undefined
    const q = (name: string) => quoteIdentifier(dialect, name)
    const limit = dialectCapabilities(dialect).pageClause(100, 0).replace(/^OFFSET 0 ROWS /, '')
    const notes = rows.slice(0, 20).map(item => `-- ${item.name} · 基表 ${item.tables ?? '?'} · 视图 ${item.views ?? '?'}`).join('\n')
    return queryDraft(`${notes}\n\n-- 把「请填写表名」改成真实表名后，选中下面语句运行\nSELECT * FROM ${q(String(rows[0].name))}.${q('请填写表名')}\n${limit};`)
  }
  return { metadata, input, async read(catalog: (input: CatalogRequest) => Promise<CatalogResult>, annotate: (patch: { sql: string; params: unknown; draft?: Record<string, unknown>; tables?: string[] }) => void): Promise<CatalogToolOutcome> {
    annotate({ sql, params: statement.params, draft: draftFor() })
    const result = await catalog(input)
    if (kind === 'table') {
      let indexes = result.indexes
      if (dialectCapabilities(dialect).supportsShowIndex) indexes = (await catalog({ kind: 'indexes', schema: args.schema || '', table: args.table || '' })).indexes
      const columns = result.columns || []
      return { status: 'succeeded', conclusion: Array.isArray(columns) ? `读取到 ${columns.length} 个字段。` : '已读取表结构。', value: {
        columns, indexes, constraints: result.constraints, storage: result.storage, definition: result.definition,
        source: result.source, collectedAt: result.collectedAt, truncated: result.truncated, sql } }
    }
    const names = (result.items || []).map(item => String(item.name || '')).filter(Boolean)
    annotate({ sql, params: statement.params, draft: draftFor(result), ...(kind === 'tables' ? { tables: names } : {}) })
    const bags = [result, result.indexes, result.constraints, result.definition, result.storage] as { status?: string; reason?: string }[]
    const unavailable = bags.find(item => item?.status === 'unavailable')?.reason
    if (unavailable) return { status: 'failed', message: unavailable, conclusion: `${kind === 'schemas' ? '无法列出数据库' : '无法查找表'}：${unavailable}`, value: { unavailable: true, reason: unavailable, sql } }
    const count = (result.items || []).length
    return { status: 'succeeded', conclusion: kind === 'schemas' ? (count ? `列出 ${count} 个数据库。` : '没有可见数据库。')
      : (names.length ? `查询成功，返回 ${names.length} 张表，可继续查下一个库。` : '查询成功，未找到匹配的表。'),
    value: { items: result.items || [], more: !!result.more, ...(kind === 'tables' ? { estimated: true } : {}), source: result.source, collectedAt: result.collectedAt, sql } }
  } }
}

/** Retain the directory tool's SQL interruption and public error semantics. */
export function catalogToolFailure(error: unknown, lifecycle: OperationLifecycle): { status: OperationStatus; message: string; event?: 'timeout' | 'disconnect' } {
  const message = error instanceof Error ? error.message : '操作失败'
  const stop = executionStop({ ...lifecycle, message })
  if (isHostQueryTimeout(message)) return { status: 'failed', message }
  if (stop.status !== 'failed') return stop
  if (/超时|timeout/i.test(message)) return { status: 'unknown', message, event: 'timeout' }
  if (/连接已关闭|连接已变化/.test(message)) return { status: 'unknown', message, event: 'disconnect' }
  return { status: 'failed', message }
}

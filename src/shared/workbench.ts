import type { Environment } from './connection-permission.ts'
import type { ExecutionApiAction } from './database-actions.ts'
import { RESULT_PREVIEW_MAX_COLUMNS, SQL_FIELD_MAX_LENGTH } from './limits.ts'
import { dialectCapabilities } from './dialect-capabilities.ts'
import { clientWorkspaceDescriptor, isDataSourceId } from './data-sources/registry.ts'
import type { MaintenanceCapability } from './maintenance-capability.ts'
import type { RedisResponse } from './redis-result.ts'
import type { ExplorerListInput, ExplorerReadInput, ExplorerPage } from './explorer.ts'
import { sanitizeExecutionDocument, type ExecutionDocument } from './execution-document.ts'
export type { Environment } from './connection-permission.ts'
export { environmentLabel, isWritableEnvironment, normalizeEnvironment } from './connection-permission.ts'
export type SqlDialect = 'mysql' | 'oracle'
export type Dialect = SqlDialect | 'redis' | 'kafka'
export type QueryController = 'ai' | 'user'
export type QueryEditSource = 'ai' | 'user' | 'system' | 'format'
export type SharedQueryLastRun = { columns: string[]; rowCount: number; truncated: boolean; elapsedMs: number; message?: string; at: string; executionId?: string }
export interface SharedQuery {
  schema?: string
  sql: string
  controller: QueryController
  controllerReason?: string
  revision: number
  /** @deprecated UI 不以 lastExecutionId 作为结果主路径 */
  lastExecutionId?: string
  lastRun?: SharedQueryLastRun
}

export type SharedQueryPurpose = 'verify' | 'result'

/** AI 验证查询不得覆盖工作台结果网格；未声明 purpose 时按 SQL 形态推断。 */
export function sharedQuerySurface(sql: string, purpose?: string): SharedQueryPurpose {
  if (purpose === 'verify' || purpose === 'result') return purpose
  const text = String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;+\s*$/, '')
  if (!text) return 'result'
  if (/^SELECT\s+(?:[\d.]+|'[^']*'|NULL)(?:\s+AS\s+[A-Za-z_][\w$]*)?$/i.test(text)) return 'verify'
  if (/^SELECT\s+EXISTS\s*\(/i.test(text)) return 'verify'
  if (/^SELECT\s+COUNT\s*\(\s*(?:\*|1|[A-Za-z_`"[\].]+)\s*\)(?:\s+AS\s+[A-Za-z_][\w$]*)?(?:\s+FROM\b[\s\S]*)?$/i.test(text)
    && !/\bGROUP\s+BY\b/i.test(text)) return 'verify'
  return 'result'
}

export interface ConnectionWorkbench {
  aiDocument?: ExecutionDocument
  schema?: string
  view?: 'objects' | 'query' | 'browse' | 'ai'
  queryTabs?: { id: string; name: string; sql: string }[]
  activeTabId?: string
  templates?: string[]
  history?: string[]
  /** 连接树下一级要显示的 id；未配置或为空表示显示全部 */
  visibleSchemas?: string[]
  sharedQuery?: SharedQuery
  /** @deprecated migrated to sharedQuery */
  aiCollab?: { sql: string; lastRun?: SharedQueryLastRun }
}

/** 客户端/宿主共用的 visibleSchemas 归一化，避免非数组写入导致 UI 崩溃。 */
export function coerceVisibleSchemas(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && !!item.trim()).map(item => item.trim().slice(0, 128)))].slice(0, 200)
}

/** 过滤名单是否包含该库名。Oracle schema 大小写不敏感。 */
export function schemaNameListed(filter: string[], name: string, caseInsensitive = false): boolean {
  if (!name) return false
  if (caseInsensitive) {
    const needle = name.toLowerCase()
    return filter.some(item => item.toLowerCase() === needle)
  }
  return filter.includes(name)
}

export function catalogSchemaName(row: Record<string, unknown>): string {
  const raw = row.name ?? row.NAME ?? row.schema ?? row.SCHEMA_NAME ?? row.Database
  return typeof raw === 'string' && raw.trim() ? raw.trim() : ''
}

export type CatalogChild = { id: string; label: string }

/** 连接树下一级。空名单表示全部；当前选中项始终留下；搜索只匹配 label。 */
export function visibleCatalogChildren<T extends CatalogChild>(children: readonly T[], visibleIds: unknown, options?: { currentId?: string; search?: string; caseInsensitive?: boolean }): T[] {
  const filter = coerceVisibleSchemas(visibleIds)
  const caseInsensitive = !!options?.caseInsensitive
  const currentId = options?.currentId || ''
  const needle = (options?.search || '').trim().toLocaleLowerCase()
  return children.filter(child => {
    if (!child.id) return false
    const current = !!currentId && (caseInsensitive ? child.id.toLowerCase() === currentId.toLowerCase() : child.id === currentId)
    if (filter.length && !schemaNameListed(filter, child.id, caseInsensitive) && !current) return false
    return !needle || child.label.toLocaleLowerCase().includes(needle) || current
  })
}

/** 当前 id 仍在子节点里就保留（即使被隐藏也会继续显示）；否则用第一个可见子节点。 */
export function preferredCatalogRoot(children: readonly CatalogChild[], current: string, visibleIds: unknown): string {
  if (current && children.some(child => child.id === current)) return current
  return visibleCatalogChildren(children, visibleIds)[0]?.id || ''
}

/** 对话框里的库名：去重并按名称排序。树本身仍按目录返回顺序。 */
export function schemaCatalogChildren(rows: readonly Record<string, unknown>[]): CatalogChild[] {
  const seen = new Set<string>()
  const list: CatalogChild[] = []
  for (const row of rows) {
    const name = catalogSchemaName(row)
    if (!name || seen.has(name)) continue
    seen.add(name)
    list.push({ id: name, label: name })
  }
  return list.sort((a, b) => a.label.localeCompare(b.label))
}
export interface Connection {
  id: string
  generation?: string
  name: string
  dialect: Dialect
  environment: Environment
  database: string
  version: string
  live?: boolean
  health?: 'connecting' | 'ready' | 'degraded' | 'offline'
  databases?: string[]
  settings?: SourceConnectionSettings
  hasPassword?: boolean
  hasCa?: boolean
  passwordWarning?: string
  workbench?: ConnectionWorkbench
}
export interface ConnectionInput {
  name: string
  dialect: Exclude<Dialect, 'kafka'>
  host: string
  port: number
  database: string
  oracleMode: 'service' | 'sid'
  redisMode?: 'standalone' | 'sentinel' | 'cluster'
  sentinelMaster?: string
  tls?: boolean
  caPem?: string
  username: string
  password: string
  environment: Environment
  rememberPassword?: boolean
  useSavedPassword?: boolean
}
export interface KafkaConnectionInput {
  name: string
  dialect: 'kafka'
  brokers: string[]
  tls: boolean
  caPem?: string
  caDigest?: string
  saslMechanism: 'none' | 'plain' | 'scram-sha-256' | 'scram-sha-512'
  username: string
  password: string
  environment: Environment
  rememberPassword?: boolean
  useSavedPassword?: boolean
}
export type SourceConnectionInput = ConnectionInput | KafkaConnectionInput
export type SourceConnectionSettings = Omit<ConnectionInput, 'password' | 'rememberPassword' | 'useSavedPassword'> | Omit<KafkaConnectionInput, 'password' | 'rememberPassword' | 'useSavedPassword'>
export type WorkspaceStorageStatus = {
  executionHistory?: { degraded: boolean; retrying: boolean }
  workspace?: { degraded: boolean }
}
export interface DatabaseWorkspaceSnapshot {
  storage?: WorkspaceStorageStatus
  connections: Connection[]
  lastActiveId?: string
  passwordStorage: boolean
  revision?: number
}
export interface ConnectionTest { version: string; elapsedMs: number; database: string }
export interface Column { name: string; type: string; nullable: boolean; key?: string; comment: string; sensitive?: boolean }
export interface Table { name: string; comment: string; columns: Column[] }
export type Cell = string | null
export interface Result {
  columns: string[]
  binaryColumns?: number[]
  rows: Cell[][]
  truncated: boolean
  elapsedMs: number
  message?: string
  affectedRows?: number
  timings?: Record<string, number>
  sql?: string
    stepIndex?: number
    batch?: Result[]
  steps?: { index: number; sql: string; status: 'succeeded' | 'failed' | 'unknown' | 'not-run'; affectedRows?: number; message?: string }[]
}
export interface QueryTab { id: string; name: string; connectionId: string; sql: string; result?: Result; error?: string }
export interface WorkspaceBridge {
  conversationId?: string
  mode: 'preview' | 'host'
  connections: Connection[]
  tables(connection: Connection): Table[]
  execute(connection: Connection, sql: string, signal: AbortSignal): Promise<Result>
  executeManual?(connection: Connection, sql: string, signal: AbortSignal): Promise<Result>
  testConnection?(input: SourceConnectionInput, replaceId?: string): Promise<ConnectionTest>
  connect?(input: SourceConnectionInput): Promise<Connection>
  listWorkspace?(): Promise<DatabaseWorkspaceSnapshot>
  listConnections?(): Promise<Connection[]>
  removeConnection?(id: string): Promise<void>
  disconnectConnection?(id: string): Promise<void>
  updateConnection?(id: string, input: SourceConnectionInput): Promise<Connection>
  duplicateConnection?(id: string): Promise<Connection>
  saveWorkbench?(id: string, workbench: ConnectionWorkbench): Promise<ConnectionWorkbench>
  activate?(id?: string): Promise<void>
  catalog?(connection: Connection, input: CatalogRequest, signal?: AbortSignal): Promise<CatalogResult>
  browse?(connection: Connection, input: BrowseRequest, signal?: AbortSignal): Promise<Result & { generatedSql: string; warning: string }>
  maintenance?(connection: Connection, input: Record<string, unknown>): Promise<MaintenanceResult>
  executions?(action: ExecutionApiAction, body?: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>
  templates?(action: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>
  redis?(connection: Connection, action: 'redis-command' | 'redis-scan' | 'redis-key-suggest' | 'redis-key', input: Record<string, unknown>, signal?: AbortSignal): Promise<RedisResponse>
  /** Source-neutral authenticated request; Host selects the provider from the saved connection. */
  sourceRequest?(connection: Connection, action: string, input: object, signal?: AbortSignal): Promise<unknown>
  executeText?(connection: Connection, text: string, context?: Record<string, string>, signal?: AbortSignal): Promise<unknown>
  explorer?(connection: Connection, action: 'list', input: ExplorerListInput, signal?: AbortSignal): Promise<ExplorerPage>
  explorer?(connection: Connection, action: 'read', input: ExplorerReadInput, signal?: AbortSignal): Promise<unknown>
}
export interface MaintenanceResult extends Partial<MaintenanceCapability> { id?: string; expiresAt?: number; executionId?: string; sql?: string; params?: (string | null)[]; status?: string; message?: string; enabled?: boolean; environment?: string; destructive?: boolean; before?: CatalogResult; steps?: { sql: string; kind: string; state: string; error?: string }[]; expectedRows?: number; revision?: string }
export interface BrowseRequest { schema: string; table: string; page: number; filters?: { column: string; operator: string; value: string }[]; sort?: { column: string; direction: string } }
export interface CatalogRequest {
  kind: 'schemas' | 'schema' | 'tables' | 'table' | 'indexes'
  schema?: string
  table?: string
  search?: string
  offset?: number
  refresh?: boolean
}
export interface CatalogResult {
  items?: Record<string, unknown>[]
  more?: boolean
  columns?: Record<string, unknown>[]
  indexes?: CatalogSection<CatalogIndex>
  constraints?: CatalogSection<CatalogConstraint>
  primaryKeys?: string[]
  collectedAt: string
  source: string
  [key: string]: unknown
}
export interface CatalogSection<T> { status: 'actual' | 'omitted' | 'unavailable'; values: T[]; reason?: string }
export interface CatalogIndex extends Record<string, unknown> { name: string; unique: boolean; type: string; columns: string[] }
export interface CatalogConstraint extends Record<string, unknown> { name: string; type: 'primary' | 'unique' | 'foreign' | 'check'; columns: string[]; status?: string; referencedOwner?: unknown; referencedConstraint?: unknown; deleteRule?: unknown; expression?: unknown }

export function quoteIdentifier(dialect: Dialect, name: string): string {
  const quote = dialectCapabilities(dialect).identifierQuote
  return quote + name.replaceAll(quote, quote + quote) + quote
}
export function isCatalogView(kind: unknown): boolean {
  return /VIEW/i.test(String(kind || ''))
}

const SYSTEM_SCHEMAS = new Set(['mysql', 'information_schema', 'performance_schema', 'sys', 'sysaux', 'system', 'xdb', 'outln'])
export function isSystemSchema(name: string): boolean {
  return SYSTEM_SCHEMAS.has(name.trim().toLowerCase())
}
function schemaNameOf(item: string | { name?: unknown }): string {
  return typeof item === 'string' ? item : String(item?.name || '')
}
export type PendingSchemaPick = { connectionId: string; schema: string; folder?: 'table' | 'view'; open?: { table: string; kind: 'table' | 'view' } }

/** Only apply a tree-picked schema when it belongs to the connection now becoming active. */
export function takePendingSchema(pending: PendingSchemaPick | undefined, connectionId: string): {
  schema: string
  folder?: 'table' | 'view'
  open?: { table: string; kind: 'table' | 'view' }
  rest?: PendingSchemaPick
} {
  if (!pending?.connectionId) return { schema: '' }
  if (pending.connectionId !== connectionId) return { schema: '', rest: pending }
  return {
    schema: pending.schema || '',
    ...(pending.folder ? { folder: pending.folder } : {}),
    ...(pending.open ? { open: pending.open } : {}),
  }
}

/** Whether this live connection may catalog/query the given schema. Empty schema means “use login default later”. */
export function connectionOwnsSchema(connection: {
  dialect: Dialect
  database?: string
  databases?: string[]
  settings?: { username?: string }
}, schema?: string): boolean {
  const name = schema?.trim()
  if (!name) return true
  const source = clientWorkspaceDescriptor(connection.dialect)
  return source.family === 'sql' ? source.ownsSchema(connection, name) : false
}

/** Saved workbench schema first, then login identity, then the first non-system schema. Never returns a name absent from the catalog list. */
export function pickDefaultSchema(input: {
  dialect: Dialect
  schemas: Array<string | { name?: unknown }>
  savedSchema?: string
  database?: string
  username?: string
}): string {
  const names = input.schemas.map(schemaNameOf).filter(Boolean)
  const source = clientWorkspaceDescriptor(input.dialect)
  return source.family === 'sql' ? source.pickDefaultSchema(names, input.savedSchema, input.database, input.username) : ''
}
export function composeTableSelect(dialect: Dialect, schema: string, table: string, input: { filter?: string; sortField?: string; sortOrder?: 'ASC' | 'DESC' | null; page?: number } = {}): string {
  const q = (name: string) => quoteIdentifier(dialect, name)
  const page = Math.max(1, Number(input.page) || 1)
  const offset = (page - 1) * 100
  const filter = input.filter?.trim()
  const order = input.sortField && (input.sortOrder === 'ASC' || input.sortOrder === 'DESC') ? `\nORDER BY ${q(input.sortField)} ${input.sortOrder}` : ''
  const where = filter ? `\nWHERE ${filter}` : ''
  const limit = `\n${dialectCapabilities(dialect).pageClause(100, offset)}`
  return `SELECT * FROM ${q(schema)}.${q(table)}${where}${order}${limit}`
}
export function draftSelects(dialect: Dialect, schema: string, tables: string[]): string {
  const q = (name: string) => quoteIdentifier(dialect, name)
  const limit = dialectCapabilities(dialect).pageClause(100, 0).replace(/^OFFSET 0 ROWS /, '')
  return tables.slice(0, 12).map(name => `-- ${name}\nSELECT * FROM ${q(schema)}.${q(name)}\n${limit};`).join('\n\n')
}
export function selectTable(connection: Connection, table: Table): string {
  const q = (name: string) => quoteIdentifier(connection.dialect, name)
  const owner = connection.database
  const limit = dialectCapabilities(connection.dialect).pageClause(100, 0).replace(/^OFFSET 0 ROWS /, '')
  return `SELECT ${table.columns.map(c => q(c.name)).join(', ')}\nFROM ${q(owner)}.${q(table.name)}\n${limit};`
}
export function visibleTables(tables: Table[], query: string): Table[] {
  const needle = query.trim().toLocaleLowerCase()
  return tables.filter(t => [t.name, t.comment, ...t.columns.map(c => c.name)].some(value => value.toLocaleLowerCase().includes(needle)))
}
/** Exports contain only already displayed values; never a fresh database query. */
export function exportResult(result: Result, format: 'csv' | 'json' | 'markdown'): string {
  if (format === 'json') return JSON.stringify({ truncated: result.truncated, columns: result.columns, rows: result.rows }, null, 2)
  const safe = (value: Cell) => value === null ? 'NULL' : value
  if (format === 'markdown') {
    const escape = (value: Cell) => safe(value).replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\r', '').replaceAll('\n', '<br>')
    return `| ${result.columns.map(escape).join(' | ')} |\n| ${result.columns.map(() => '---').join(' | ')} |\n` + result.rows.map(row => `| ${row.map(escape).join(' | ')} |`).join('\n') + (result.truncated ? '\n\n仅包含已加载结果，结果已截断。' : '')
  }
  const escape = (value: Cell) => {
    let text = safe(value)
    // Prevent exported cells becoming formulas when opened in a spreadsheet.
    if (/^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text
    return '"' + text.replaceAll('"', '""') + '"'
  }
  return '\uFEFF' + [result.columns, ...result.rows].map(row => row.map(escape).join(',')).join('\r\n')
}

export function newTab(connection: Connection, sql = ''): QueryTab {
  return { id: crypto.randomUUID(), name: '未命名查询', connectionId: connection.id, sql }
}

export function queryTabNeedsCloseConfirm(tab?: QueryTab): boolean {
  if (!tab) return false
  return !!tab.sql.trim() || !!tab.result || !!tab.error
}

export { keepResultOnFailure, ConnectionRequestError, shouldMarkConnectionOffline, isAbortError } from './connection-errors.ts'

export function normalizeSqlTemplate(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

export function dedupeSqlTemplates(list: string[], sql: string): string[] {
  const key = normalizeSqlTemplate(sql)
  if (!key) return list.slice(0, 20)
  return [sql.trim(), ...list.filter(item => normalizeSqlTemplate(item) !== key)].slice(0, 20)
}

function clipSqlList(values: unknown, limit: number): string[] {
  if (!Array.isArray(values)) return []
  return values.filter((item): item is string => typeof item === 'string' && !!item.trim()).map(item => item.slice(0, SQL_FIELD_MAX_LENGTH)).slice(0, limit)
}

export function emptySharedQuery(): SharedQuery {
  return { sql: '', controller: 'ai', revision: 1 }
}

function sanitizeLastRun(value: unknown): SharedQueryLastRun | undefined {
  if (!value || typeof value !== 'object') return
  const run = value as SharedQueryLastRun
  if (!Array.isArray(run.columns)) return
  return {
    columns: run.columns.filter((name): name is string => typeof name === 'string').slice(0, RESULT_PREVIEW_MAX_COLUMNS),
    rowCount: Number.isFinite(Number(run.rowCount)) ? Math.max(0, Number(run.rowCount)) : 0,
    truncated: !!run.truncated,
    elapsedMs: Number.isFinite(Number(run.elapsedMs)) ? Math.max(0, Number(run.elapsedMs)) : 0,
    ...(typeof run.message === 'string' ? { message: run.message.slice(0, 500) } : {}),
    at: typeof run.at === 'string' ? run.at.slice(0, 40) : '',
    ...(typeof run.executionId === 'string' ? { executionId: run.executionId.slice(0, 160) } : {}),
  }
}

export function sanitizeSharedQuery(value: unknown): SharedQuery {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const sql = typeof raw.sql === 'string' ? raw.sql.slice(0, SQL_FIELD_MAX_LENGTH) : ''
  const schema = typeof raw.schema === 'string' ? raw.schema.slice(0, 128) : undefined
  const controller = raw.controller === 'user' ? 'user' : 'ai'
  const revision = Number.isInteger(Number(raw.revision)) && Number(raw.revision) > 0 ? Math.min(Number(raw.revision), 1_000_000_000) : 1
  const lastExecutionId = typeof raw.lastExecutionId === 'string' ? raw.lastExecutionId.slice(0, 160) : undefined
  const lastRun = sanitizeLastRun(raw.lastRun)
  const controllerReason = typeof raw.controllerReason === 'string' ? raw.controllerReason.slice(0, 40) : undefined
  return {
    sql,
    controller,
    revision,
    ...(schema ? { schema } : {}),
    ...(controllerReason ? { controllerReason } : {}),
    ...(lastExecutionId ? { lastExecutionId } : {}),
    ...(lastRun ? { lastRun } : {}),
  }
}

function migrateSharedQuery(input: ConnectionWorkbench): SharedQuery | undefined {
  if (input.sharedQuery && typeof input.sharedQuery === 'object') return sanitizeSharedQuery(input.sharedQuery)
  const collab = input.aiCollab
  if (!collab || typeof collab !== 'object') return
  const lastRun = sanitizeLastRun(collab.lastRun)
  const sql = typeof collab.sql === 'string' ? collab.sql.slice(0, SQL_FIELD_MAX_LENGTH) : ''
  if (!sql && !lastRun) return
  return sanitizeSharedQuery({ sql, controller: 'ai', revision: 1, lastRun })
}

export function sanitizeConnectionWorkbench(value: unknown): ConnectionWorkbench {
  const input = value && typeof value === 'object' ? value as ConnectionWorkbench : {}
  const queryTabs = Array.isArray(input.queryTabs) ? input.queryTabs.slice(0, 8).flatMap(tab => {
    if (!tab || typeof tab !== 'object' || typeof tab.id !== 'string' || !tab.id || tab.id.length > 160) return []
    const sql = typeof tab.sql === 'string' ? tab.sql.slice(0, SQL_FIELD_MAX_LENGTH) : ''
    const name = typeof tab.name === 'string' && tab.name.trim() ? tab.name.slice(0, 80) : '未命名查询'
    return [{ id: tab.id, name, sql }]
  }) : []
  const view = input.view === 'query' || input.view === 'browse' || input.view === 'objects' || input.view === 'ai' ? input.view : undefined
  const schema = typeof input.schema === 'string' ? input.schema.slice(0, 128) : undefined
  const activeTabId = typeof input.activeTabId === 'string' && queryTabs.some(tab => tab.id === input.activeTabId) ? input.activeTabId : queryTabs[0]?.id
  const sharedQuery = migrateSharedQuery(input)
  const aiDocument = input.aiDocument && isDataSourceId(input.aiDocument.sourceId) && typeof input.aiDocument.text === 'string'
    && Number.isInteger(input.aiDocument.revision) && input.aiDocument.revision > 0
    && input.aiDocument.context && typeof input.aiDocument.context === 'object' && !Array.isArray(input.aiDocument.context)
    && Object.values(input.aiDocument.context).every(value => typeof value === 'string')
    ? sanitizeExecutionDocument(input.aiDocument, input.aiDocument.sourceId) : undefined
  return {
    ...(schema ? { schema } : {}),
    ...(view ? { view } : {}),
    ...(queryTabs.length ? { queryTabs, activeTabId } : {}),
    templates: clipSqlList(input.templates, 20),
    history: clipSqlList(input.history, 30),
    ...(sharedQuery ? { sharedQuery } : {}),
    ...(aiDocument ? { aiDocument } : {}),
  }
}

/** Offline fallback wrapped by connectionBridge. Live connections send SQL to the host HTTP API. */
export const unavailableBridge: WorkspaceBridge = {
  mode: 'host', connections: [], tables: () => [],
  async execute() { throw new Error('当前连接未登录，未执行任何 SQL。') },
  async executeManual() { throw new Error('当前连接未登录，未执行任何 SQL。') },
}

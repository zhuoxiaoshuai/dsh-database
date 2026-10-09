import type { Result } from './workbench.ts'
import type { DatabaseOperation } from './database-actions.ts'
import type { ExecutionDocument } from './execution-document.ts'
import type { DataSourceId } from './data-sources/types.ts'
import { RESULT_PREVIEW_MAX_BYTES, RESULT_PREVIEW_MAX_COLUMNS, RESULT_PREVIEW_MAX_ROWS } from './limits.ts'

/** Captured once before dispatch. Live replies must never reconstruct this from current state. */
export interface DocumentExecutionIdentity {
  conversationId: string
  connectionId: string
  sourceId: DataSourceId
  generation: string
  context: Record<string, string>
  queryRevision: number
  documentText: string
  executedSql: string
  initiator: 'ai' | 'user'
}

export interface DocumentExecutionResult {
  identity: DocumentExecutionIdentity
  executionId: string
  result: unknown
  kind?: ExecutionType
  message?: string
}

export const EXECUTION_STATUSES = ['preparing', 'checking', 'awaiting_confirmation', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'] as const
export type ExecutionStatus = typeof EXECUTION_STATUSES[number]
export const EXECUTION_STATUS_LABELS: Record<ExecutionStatus, string> = {
  preparing: '准备中',
  checking: '检查中',
  awaiting_confirmation: '等待确认',
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  unknown: '结果未知',
}

const rank: Record<ExecutionStatus, number> = {
  preparing: 0,
  checking: 1,
  awaiting_confirmation: 2,
  running: 3,
  succeeded: 10,
  failed: 10,
  cancelled: 10,
  unknown: 10,
}

export function isTerminalStatus(status: ExecutionStatus): boolean {
  return rank[status] >= 10
}

const HOST_QUERY_TIMEOUT = /查询超过 \d+ 秒，已超时/

export function isHostQueryTimeout(message: string): boolean {
  return HOST_QUERY_TIMEOUT.test(message)
}

/** One stop outcome for SQL page and AI Query. Timeout is not cancel. */
export function executionStop(input: { aborted: boolean; dispatched: boolean; message: string }): { status: 'cancelled' | 'unknown' | 'failed'; message: string } {
  const message = input.message || '执行失败'
  if (isHostQueryTimeout(message)) return { status: 'failed', message }
  const aborted = input.aborted || /取消/.test(message)
  if (aborted) {
    return input.dispatched
      ? { status: 'unknown', message: '结果未知。' }
      : { status: 'cancelled', message: '已取消。' }
  }
  return { status: 'failed', message }
}

export function canTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  if (from === to) return true
  if (isTerminalStatus(from)) return false
  if (isTerminalStatus(to)) return true
  return rank[to] >= rank[from]
}

export type ExecutionEventKind = 'created' | 'check-passed' | 'check-rejected' | 'dispatched' | 'result' | 'cancel' | 'timeout' | 'disconnect' | 'late-result'
export interface ExecutionEvent {
  kind: ExecutionEventKind
  at: string
  elapsedMs: number
  message?: string
}

export const EXECUTION_TYPES = ['query', 'verify', 'write', 'explain', 'catalog', 'tool'] as const
export type ExecutionType = typeof EXECUTION_TYPES[number]

export interface ExecutionRecord {
  identity?: DocumentExecutionIdentity
  context?: Record<string, string>
  executionId: string
  conversationId: string
  callId: string
  rootCallId: string
  connectionId?: string
  generation?: string
  connectionName?: string
  dialect?: string
  environment?: string
  schema?: string
  operation: string
  tables: string[]
  columns?: string[]
  status: ExecutionStatus
  createdAt: string
  updatedAt: string
  sql?: string
  paramSummary?: unknown
  message?: string
  resultMeta?: { columns: string[]; rowCount: number; truncated: boolean; elapsedMs: number }
  resultPersisted: boolean
  events: ExecutionEvent[]
  draft?: Record<string, unknown>
  revision: number
  initiator?: 'ai' | 'user'
  resultPreview?: Result
  historyVisible?: boolean
  title?: string
  reason?: string
  conclusion?: string
  type?: ExecutionType
  queryRevision?: number
  executedSql?: string
  documentText?: string
}

export const WORKBENCH_EVENT_TYPES = ['QUERY_CHANGED', 'CONTROL_CHANGED', 'EXECUTION_DOCUMENT_CHANGED', 'EXECUTION_STARTED', 'EXECUTION_FINISHED', 'EXECUTION_FAILED'] as const
export type WorkbenchEventType = typeof WORKBENCH_EVENT_TYPES[number]
export interface WorkbenchEvent {
  identity?: DocumentExecutionIdentity
  context?: Record<string, string>
  conversationId?: string
  documentText?: string
  type: WorkbenchEventType
  connectionId?: string
  generation?: string
  executionId?: string
  queryRevision?: number
  sql?: string
  executedSql?: string
  controller?: 'ai' | 'user'
  initiator?: 'ai' | 'user'
  status?: ExecutionStatus
  result?: Result
  schema?: string
  document?: ExecutionDocument
  sourceResult?: Record<string, unknown>
  kind?: 'query' | 'write' | 'explain'
  message?: string
}

export interface DisplayResult {
  identity?: DocumentExecutionIdentity
  context?: Record<string, string>
  generation?: string
  schema?: string
  documentText?: string
  initiator?: 'ai' | 'user'
  conversationId?: string
  connectionId: string
  executionId: string
  queryRevision: number
  executedSql: string
  result: Result
  kind?: 'query' | 'write' | 'explain'
}

export function inferExecutionType(operation: string, purpose?: string): ExecutionType {
  if (purpose === 'verify') return 'verify'
  return executionOperationMetadata(operation)?.type || 'tool'
}

export function isDisplayHistoryExecution(record: Pick<ExecutionRecord, 'type' | 'operation' | 'status'>): boolean {
  const type = record.type || inferExecutionType(record.operation)
  if (record.status === 'awaiting_confirmation') return true
  return type === 'query' || type === 'write' || type === 'explain'
}

export function historyItemsForConnection(items: ExecutionRecord[], connectionId?: string, legacyVisible?: (record: ExecutionRecord) => boolean): ExecutionRecord[] {
  return items.filter(item => {
    if (connectionId && item.connectionId !== connectionId) return false
    return isDisplayHistoryExecution(item) || item.historyVisible === true || legacyVisible?.(item) === true
  })
}

export function publicExecution(record: ExecutionRecord, result?: Result): ExecutionRecord & { result?: Result; resultMissing?: boolean } {
  const { resultPreview: _preview, ...rest } = record
  if (result) return { ...rest, result }
  if (record.resultMeta && !record.resultPersisted) return { ...rest, resultMissing: true }
  return rest
}

export function clipSql(sql: unknown): string | undefined {
  if (typeof sql !== 'string' || !sql) return undefined
  const bytes = new TextEncoder().encode(sql).length
  if (bytes <= 16 * 1024) return sql
  return sql.slice(0, 16 * 1024)
}

function clipOneResultPreview(result: Result): Result {
  const kept: Result['rows'] = []
  let bytes = 0
  for (const row of (result.rows || []).slice(0, RESULT_PREVIEW_MAX_ROWS)) {
    const clipped = row.slice(0, RESULT_PREVIEW_MAX_COLUMNS)
    const size = new TextEncoder().encode(JSON.stringify(clipped)).length
    if (kept.length && bytes + size > RESULT_PREVIEW_MAX_BYTES) break
    kept.push(clipped)
    bytes += size
  }
  return {
    columns: (result.columns || []).slice(0, RESULT_PREVIEW_MAX_COLUMNS),
    ...(Array.isArray(result.binaryColumns) ? { binaryColumns: result.binaryColumns.filter(index => Number.isInteger(index) && index >= 0 && index < Math.min((result.columns || []).length, RESULT_PREVIEW_MAX_COLUMNS)) } : {}),
    rows: kept,
    truncated: result.truncated || kept.length < (result.rows || []).length,
    elapsedMs: result.elapsedMs,
    ...(result.sql ? { sql: result.sql } : {}),
    ...(result.stepIndex !== undefined ? { stepIndex: result.stepIndex } : {}),
    ...(result.message ? { message: result.message.slice(0, 500) } : {}),
    ...(result.affectedRows !== undefined ? { affectedRows: result.affectedRows } : {}),
  }
}

export function clipResultPreview(result?: Result): Result | undefined {
  if (!result) return
  const clipped = clipOneResultPreview(result)
  if (Array.isArray(result.steps)) clipped.steps = result.steps.slice(0, 16).map(step => ({ index: step.index, sql: step.sql.slice(0, 2048), status: step.status, ...(step.affectedRows !== undefined ? { affectedRows: step.affectedRows } : {}), ...(step.message ? { message: step.message.slice(0, 300) } : {}) }))
  if (Array.isArray(result.batch) && result.batch.length) {
    clipped.batch = result.batch.slice(0, 8).map(item => clipOneResultPreview(item))
  }
  return clipped
}

export const EXECUTION_TITLE_MAX = 120
export const EXECUTION_REASON_MAX = 160

export function clipNarrative(value: unknown, max = 160): string | undefined {
  if (typeof value !== 'string') return
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return
  return text.slice(0, max)
}

function clipLabel(value: unknown, max = 32): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function sqlBindValues(sql?: string): string[] {
  const match = sql?.match(/-- params:\s*(\[[\s\S]*\])\s*$/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[1])
    return Array.isArray(parsed) ? parsed.map(item => clipLabel(item, 40)).filter(Boolean) : []
  } catch {
    return []
  }
}

function joinNames(names: string[], max = 2): string {
  const unique = [...new Set(names.map(name => clipLabel(name)).filter(Boolean))]
  if (!unique.length) return ''
  return unique.slice(0, max).join('、') + (unique.length > max ? ' 等' : '')
}

type TitleSource = Pick<ExecutionRecord, 'title' | 'operation' | 'initiator' | 'schema' | 'tables' | 'sql' | 'connectionName' | 'reason'>

type TitleContext = { schema: string; tables: string; search: string }
type OperationMetadata = {
  title: string
  type: ExecutionType
  inferTitle?: (record: TitleSource, context: TitleContext) => string
}

const EXECUTION_OPERATION_METADATA = {
  database_list_connections: { title: '列出已登录连接', type: 'catalog', inferTitle: () => '列出已登录连接，为后续查库准备 connectionId' },
  database_import_connections: { title: '批量登记连接', type: 'tool', inferTitle: () => '批量登记数据库连接，供稍后在工作台补密码登录' },
  database_list_schemas: {
    title: '列出数据库', type: 'catalog',
    inferTitle: record => record.connectionName ? `列出 ${clipLabel(record.connectionName)} 的数据库，确认可见库和表数量` : '列出数据库，确认可见库和表数量',
  },
  database_search_tables: {
    title: '查找表', type: 'catalog',
    inferTitle: (_record, { schema, search }) => {
      if (schema && search) return `查找 ${schema} 中匹配“${search}”的表，定位业务表`
      if (schema) return `查找 ${schema} 中的表，确认有哪些业务表`
      return '查找表，定位可用业务表'
    },
  },
  database_describe_table: {
    title: '查看表结构', type: 'catalog',
    inferTitle: (_record, { schema, tables }) => {
      if (schema && tables) return `查看 ${schema}.${tables} 的结构，确认字段后再写查询`
      if (tables) return `查看 ${tables} 的结构，确认字段后再写查询`
      return '查看表结构，确认字段后再写查询'
    },
  },
  database_query_readonly: {
    title: '执行只读查询', type: 'query',
    inferTitle: (_record, { schema, tables }) => tables
      ? `查询 ${schema ? `${schema}.` : ''}${tables}，取得当前数据`
      : schema ? `在 ${schema} 中执行只读查询，取得当前数据` : '执行只读查询，取得当前数据',
  },
  database_execute_sql: {
    title: '执行 SQL', type: 'query',
    inferTitle: (_record, { schema, tables }) => tables
      ? `执行 ${schema ? `${schema}.` : ''}${tables} 的 SQL，取得当前数据`
      : schema ? `在 ${schema} 中执行 SQL，取得当前数据` : '执行 SQL，取得当前数据',
  },
  database_explain_plan: {
    title: '查看执行计划', type: 'explain',
    inferTitle: (_record, { schema, tables }) => tables || schema
      ? `查看 ${schema ? `${schema}.` : ''}${tables || '当前语句'} 的执行计划，诊断索引与扫描`
      : '查看执行计划，诊断索引与扫描',
  },
  database_search_templates: { title: '检索 SQL 经验', type: 'tool', inferTitle: () => '检索 SQL 经验，复用已发布的查询写法' },
  database_get_template: { title: '读取 SQL 经验', type: 'tool', inferTitle: () => '读取 SQL 经验原文，仍须通过当前连接策略' },
  database_save_template: { title: '保存 SQL 经验', type: 'tool', inferTitle: record => record.title?.trim() || '保存 SQL 经验到经验库' },
  database_read_collab: { title: '读取 AI Query', type: 'tool', inferTitle: () => '读取当前 AI Query，核对用户是否已改写或接管' },
  database_status: { title: '查看工作台状态', type: 'tool' },
  database_catalog: {
    title: '查看字典', type: 'catalog',
    inferTitle: (record, { schema, tables, search }) => {
      if (schema && tables) return `查看 ${schema}.${tables} 的结构，确认字段后再写查询`
      if (tables) return `查看 ${tables} 的结构，确认字段后再写查询`
      if (schema && search) return `查找 ${schema} 中匹配“${search}”的表，定位业务表`
      if (schema) return `查找 ${schema} 中的表，确认有哪些业务表`
      return record.connectionName ? `列出 ${clipLabel(record.connectionName)} 的数据库，确认可见库和表数量` : '列出数据库，确认可见库和表数量'
    },
  },
  database_templates: {
    title: 'SQL 经验', type: 'tool',
    inferTitle: record => record.sql?.trim() ? '保存 SQL 经验到经验库' : '检索 SQL 经验，复用已发布的查询写法',
  },
  shared_query_write: {
    title: '执行写 SQL', type: 'write',
    inferTitle: (_record, { tables }) => tables ? `执行对 ${tables} 的写 SQL` : '执行写 SQL',
  },
  workbench_shared_query: {
    title: '执行查询', type: 'query',
    inferTitle: (_record, { schema, tables }) => tables ? `执行 ${schema ? `${schema}.` : ''}${tables} 的查询` : '执行当前 SQL',
  },
  redis_status: { title: '查看 Redis 状态', type: 'tool' },
  redis_keys: { title: '扫描 Redis Key', type: 'catalog' },
  redis_value: { title: '读取 Redis Key', type: 'tool' },
  redis_execute: { title: '执行 Redis 命令', type: 'tool' },
} satisfies Record<DatabaseOperation, OperationMetadata>

function executionOperationMetadata(operation: string): OperationMetadata | undefined {
  return EXECUTION_OPERATION_METADATA[operation as DatabaseOperation]
}

function inferredExecutionTitle(record: TitleSource): string | undefined {
  const metadata = executionOperationMetadata(record.operation)
  if (!metadata?.inferTitle) return
  const binds = sqlBindValues(record.sql)
  return metadata.inferTitle(record, {
    schema: clipLabel(record.schema) || binds[0] || '',
    tables: joinNames([...(record.tables || []), binds[1] || ''].filter(Boolean)),
    search: /LOCATE\(|INSTR\(/.test(record.sql || '') ? (binds[1] || '') : '',
  })
}

export function executionTitle(record: TitleSource): string {
  const stored = record.title?.trim()
  const metadata = executionOperationMetadata(record.operation)
  if (stored && stored !== metadata?.title) return stored
  return inferredExecutionTitle(record) || metadata?.title || (record.initiator === 'user' ? '执行查询' : '数据库操作')
}

export function executionReason(record: Pick<ExecutionRecord, 'reason' | 'operation' | 'schema' | 'tables'>): string | undefined {
  if (record.reason?.trim()) return record.reason.trim()
  const title = inferredExecutionTitle(record)
  const purpose = title?.includes('，') ? title.slice(title.indexOf('，') + 1) : undefined
  return purpose
}

export function executionConclusion(record: Pick<ExecutionRecord, 'conclusion' | 'status' | 'message' | 'resultMeta'>): string {
  if (record.conclusion?.trim()) return record.conclusion.trim()
  if (record.status === 'succeeded') {
    if (record.resultMeta) return `返回 ${record.resultMeta.rowCount} 行${record.resultMeta.truncated ? '（已截断）' : ''}`
    return record.message?.trim() || '已完成'
  }
  if (record.status === 'failed') return record.message?.trim() || '执行失败'
  if (record.status === 'cancelled') return record.message?.trim() || '已取消'
  if (record.status === 'unknown') return record.message?.trim() || '结果未知'
  if (record.status === 'awaiting_confirmation') return record.message?.trim() || '等待人工确认'
  return EXECUTION_STATUS_LABELS[record.status] || record.status
}

type OutcomeSource = Pick<ExecutionRecord, 'operation' | 'status' | 'conclusion' | 'message' | 'resultMeta' | 'tables'>

function finishSentence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return trimmed
  return /[。！？]$/.test(trimmed) ? trimmed : `${trimmed}。`
}

export function executionOutcomeSummary(record: OutcomeSource): string {
  const base = executionConclusion(record)
  if (record.status === 'succeeded' && record.operation === 'database_search_tables') {
    const fromText = base.match(/找到\s*(\d+)\s*个表/)
    if (fromText) return `查询成功，返回 ${fromText[1]} 张表，可继续查下一个库。`
    if (/未找到/.test(base)) return '查询成功，未找到匹配的表。'
    if (record.tables?.length) return `查询成功，返回 ${record.tables.length} 张表，可继续查下一个库。`
  }
  if (record.status === 'succeeded' && (record.operation === 'database_list_schemas' || record.operation === 'database_catalog')) {
    const fromText = base.match(/列出\s*(\d+)\s*个数据库/)
    if (fromText) return `查询成功，列出 ${fromText[1]} 个数据库。`
  }
  if (record.status === 'succeeded' && (record.operation === 'database_describe_table' || record.operation === 'database_catalog')) {
    const fromText = base.match(/读取到\s*(\d+)\s*个字段/)
    if (fromText) return `查询成功，读取到 ${fromText[1]} 个字段。`
  }
  if (record.status === 'succeeded' && record.resultMeta) {
    return `查询成功，返回 ${record.resultMeta.rowCount} 行${record.resultMeta.truncated ? '（已截断）' : ''}。`
  }
  if (record.status === 'succeeded') {
    if (base !== '已完成') return finishSentence(base)
    return '查询成功。'
  }
  return finishSentence(base)
}

export function executionLocalDayKey(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function executionLocalDayLabel(dayKey: string, now = new Date()): string {
  if (!dayKey) return '未知日期'
  const today = executionLocalDayKey(now.toISOString())
  const yesterdayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const yesterday = executionLocalDayKey(yesterdayDate.toISOString())
  if (dayKey === today) return '今天'
  if (dayKey === yesterday) return '昨天'
  const [year, month, day] = dayKey.split('-').map(Number)
  if (year === now.getFullYear()) return `${month}月${day}日`
  return `${year}年${month}月${day}日`
}

export function groupExecutionsByLocalDay(items: ExecutionRecord[]): { dayKey: string; label: string; items: ExecutionRecord[] }[] {
  const groups = new Map<string, ExecutionRecord[]>()
  for (const item of items) {
    const key = executionLocalDayKey(item.createdAt)
    const list = groups.get(key) || []
    list.push(item)
    groups.set(key, list)
  }
  return [...groups.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([dayKey, rows]) => ({
      dayKey,
      label: executionLocalDayLabel(dayKey),
      items: rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }))
}

export function executionChain(items: ExecutionRecord[], selected?: ExecutionRecord): ExecutionRecord[] {
  if (!items.length) return []
  const focus = selected || items[0]
  const root = focus.rootCallId
  if (root) {
    const grouped = items
      .filter(item => (item.rootCallId || item.callId) === root)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.executionId.localeCompare(b.executionId))
    if (grouped.length) return grouped
  }
  return [focus]
}

/** UI 步骤链展示：时间正序链路的倒序，最新在前。 */
export function executionChainNewestFirst(chain: ExecutionRecord[]): ExecutionRecord[] {
  return chain.length ? [...chain].reverse() : []
}

export function summarizeParams(params: unknown): unknown {
  if (!Array.isArray(params)) return undefined
  return params.slice(0, 8).map(value => {
    if (value === null) return { type: 'null' }
    if (typeof value === 'number') return { type: 'number' }
    if (typeof value === 'boolean') return { type: 'boolean' }
    if (typeof value === 'string') return { type: 'string', length: value.length }
    return { type: 'omitted' }
  })
}

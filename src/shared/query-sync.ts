import type { Result, SharedQuery } from './workbench.ts'
import type { DisplayResult, WorkbenchEvent, DocumentExecutionIdentity, DocumentExecutionResult } from './execution.ts'
import type { ExecutionDocument } from './execution-document.ts'

export function displayKindOf(event: Pick<WorkbenchEvent, 'kind' | 'executedSql' | 'sql'>): DisplayResult['kind'] {
  if (event.kind === 'explain' || event.kind === 'write' || event.kind === 'query') return event.kind
  const sql = event.executedSql || event.sql || ''
  if (/^explain\b/i.test(sql.trim())) return 'explain'
  return 'query'
}

export type ResultIdentity = {
  conversationId?: string; connectionId?: string; generation?: string; schema?: string
  context?: Record<string, string>
  queryRevision?: number; documentText?: string; executedSql?: string; initiator?: 'ai' | 'user'
}
export type ResultOwner = {
  conversationId?: string; connectionId: string; generation?: string; schema?: string
  context?: Record<string, string>
  queryRevision: number; sql: string; controller?: SharedQuery['controller']
}

/** Legacy records can be read, but incomplete identities cannot become a current result. */
export function documentResult(value: unknown): DocumentExecutionResult | undefined {
  if (!value || typeof value !== 'object') return
  const input = value as Partial<DocumentExecutionResult>
  const identity = input.identity
  if (!identity || typeof input.executionId !== 'string' || !input.executionId
    || !input.result || typeof input.result !== 'object' || Array.isArray(input.result)) return
  if (typeof identity.conversationId !== 'string' || typeof identity.connectionId !== 'string'
    || !['mysql', 'oracle', 'redis', 'kafka'].includes(identity.sourceId) || typeof identity.generation !== 'string'
    || !identity.context || typeof identity.context !== 'object' || Array.isArray(identity.context)
    || Object.values(identity.context).some(value => typeof value !== 'string')
    || !Number.isInteger(identity.queryRevision) || identity.queryRevision < 1
    || typeof identity.documentText !== 'string' || typeof identity.executedSql !== 'string'
    || !['ai', 'user'].includes(identity.initiator)) return
  if (identity.sourceId === 'mysql' || identity.sourceId === 'oracle') {
    const result = input.result as Partial<Result>
    if (!Array.isArray(result.columns) || !Array.isArray(result.rows) || typeof result.elapsedMs !== 'number'
      || typeof result.truncated !== 'boolean') return
  }
  return input as DocumentExecutionResult
}

/** Displayed receipts survive edits, but never cross a connection or target boundary. */
export function sameDocumentResultTarget(identity: DocumentExecutionIdentity, owner: {
  connectionId: string; generation?: string; conversationId?: string; document: ExecutionDocument
}): boolean {
  return identity.connectionId === owner.connectionId && identity.generation === owner.generation
    && identity.sourceId === owner.document.sourceId && (!owner.conversationId || identity.conversationId === owner.conversationId)
    && Object.keys(identity.context).length === Object.keys(owner.document.context).length
    && Object.keys(owner.document.context).every(key => identity.context[key] === owner.document.context[key])
}

export function ownsDocumentResult(identity: DocumentExecutionIdentity, owner: {
  connectionId: string; generation?: string; conversationId?: string; document: ExecutionDocument; unsaved?: boolean
}): boolean {
  return !owner.unsaved && identity.sourceId === owner.document.sourceId
    && matchesResultOwner(identity, { connectionId: owner.connectionId, generation: owner.generation,
      conversationId: owner.conversationId, context: owner.document.context, sql: owner.document.text,
      queryRevision: owner.document.revision, controller: owner.document.controller })
}

export function sqlDisplay(value: DocumentExecutionResult | undefined): DisplayResult | undefined {
  if (!value || (value.identity.sourceId !== 'mysql' && value.identity.sourceId !== 'oracle')) return
  return { ...value.identity, identity: value.identity, schema: value.identity.context.schema || '',
    executionId: value.executionId, result: value.result as Result,
    kind: value.kind === 'explain' || value.kind === 'write' ? value.kind : 'query' }
}

/** The same complete identity is required for live, direct and recovered results. */
export function matchesResultOwner(result: ResultIdentity, owner: ResultOwner): boolean {
  return typeof result.generation === 'string' && typeof owner.generation === 'string'
    && result.connectionId === owner.connectionId && result.generation === owner.generation
    && (owner.context ? !!result.context && Object.keys(result.context).length === Object.keys(owner.context).length
      && Object.keys(owner.context).every(key => result.context![key] === owner.context![key])
      : typeof result.schema === 'string' && result.schema === (owner.schema ?? ''))
    && result.queryRevision === owner.queryRevision && typeof result.documentText === 'string'
    && result.documentText === owner.sql
    && typeof result.executedSql === 'string' && (result.initiator === 'user' || result.initiator === 'ai')
    && (!owner.conversationId || result.conversationId === owner.conversationId)
    && !(result.initiator === 'ai' && owner.controller === 'user')
}

export function displayMatchingEditor(current: DisplayResult | undefined, editorSql: string): DisplayResult | undefined {
  if (!current) return
  if (current.documentText === editorSql) return current
  return undefined
}

function gridRicher(current: Result, incoming: Result): boolean {
  return current.columns.length > incoming.columns.length || current.rows.length > incoming.rows.length
    || (current.steps?.length || 0) > (incoming.steps?.length || 0) || (current.batch?.length || 0) > (incoming.batch?.length || 0)
}

/** Live grid keeps the execution receipt. A clipped preview of the same run must not replace it. */
export function preferLiveGrid(current: DisplayResult | undefined, incoming: DisplayResult): DisplayResult {
  if (!current || current.executionId !== incoming.executionId) return incoming
  if (!gridRicher(current.result, incoming.result)) return incoming
  return { ...incoming, result: current.result }
}

export function keepHydratedDisplay(current: DisplayResult | undefined, next: DisplayResult | undefined, editorSql: string): DisplayResult | undefined {
  if (next) return preferLiveGrid(current, next)
  return displayMatchingEditor(current, editorSql)
}

export function applyExecutionResult(
  current: DisplayResult | undefined,
  event: WorkbenchEvent,
  opts: { connectionId: string; controller: SharedQuery['controller']; sql: string; queryRevision: number; schema?: string; generation?: string; conversationId?: string },
): DisplayResult | undefined {
  if (event.type !== 'EXECUTION_FINISHED' && event.type !== 'EXECUTION_FAILED') return current
  if (event.connectionId !== opts.connectionId || !event.executionId) return current
  if (!matchesResultOwner(event, opts)) return current && matchesResultOwner(current, opts) ? current : undefined
  const kind = displayKindOf(event)
  const failed = event.type === 'EXECUTION_FAILED'
  const message = event.message || (event.result as Result | undefined)?.message || (failed ? '执行失败' : undefined)
  const result = event.result || (failed
    ? { columns: [], rows: [], truncated: false, elapsedMs: 0, ...(message ? { message } : {}) }
    : undefined)
  if (!result) return current
  return preferLiveGrid(current, {
    connectionId: event.connectionId,
    executionId: event.executionId,
    queryRevision: event.queryRevision!, generation: event.generation, schema: event.schema, documentText: event.documentText, initiator: event.initiator, conversationId: event.conversationId, context: event.context,
    executedSql: event.executedSql!,
    result: { ...result, ...(message ? { message } : {}) } as Result,
    kind,
  })
}

export function displayFromLatest(
  connectionId: string,
  query: SharedQuery,
  latest?: { executionId?: string; connectionId?: string; queryRevision?: number; executedSql?: string; sql?: string; type?: string; result?: Result; generation?: string; schema?: string; message?: string; documentText?: string; initiator?: 'ai' | 'user'; conversationId?: string; context?: Record<string, string> } | null,
  generation?: string,
): DisplayResult | undefined {
  if (!latest?.executionId) return
  if (!matchesResultOwner(latest, { connectionId, generation, schema: query.schema, queryRevision: query.revision, sql: query.sql, controller: query.controller })) return
  const executedSql = latest.executedSql || latest.sql || ''
  if (latest.type && latest.type !== 'query' && latest.type !== 'write' && latest.type !== 'explain') return
  if (!latest.result) return
  return {
    connectionId,
    executionId: latest.executionId,
    queryRevision: latest.queryRevision!, generation: latest.generation, schema: latest.schema, documentText: latest.documentText, initiator: latest.initiator, conversationId: latest.conversationId, context: latest.context,
    executedSql,
    result: latest.result,
    kind: latest.type === 'explain' ? 'explain' : latest.type === 'write' ? 'write' : 'query',
  }
}

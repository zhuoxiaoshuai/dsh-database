import { isDataSourceId } from './data-sources/registry.ts'
import type { Result, SharedQuery } from './workbench.ts'
import type { DisplayResult, DocumentExecutionIdentity, DocumentExecutionResult } from './execution.ts'
import { sameStringMap, type ExecutionDocument } from './execution-document.ts'

export type ResultIdentity = {
  conversationId?: string; connectionId?: string; generation?: string; schema?: string
  context?: Record<string, string>
  queryRevision?: number; documentText?: string; executedSql?: string; initiator?: 'ai' | 'user'
}
type ResultOwner = {
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
    || !isDataSourceId(identity.sourceId) || typeof identity.generation !== 'string'
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
    && sameStringMap(identity.context, owner.document.context)
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
    && (owner.context ? !!result.context && sameStringMap(result.context, owner.context)
      : typeof result.schema === 'string' && result.schema === (owner.schema ?? ''))
    && result.queryRevision === owner.queryRevision && typeof result.documentText === 'string'
    && result.documentText === owner.sql
    && typeof result.executedSql === 'string' && (result.initiator === 'user' || result.initiator === 'ai')
    && (!owner.conversationId || result.conversationId === owner.conversationId)
    && !(result.initiator === 'ai' && owner.controller === 'user')
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

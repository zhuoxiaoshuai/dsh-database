import type { Connection, DatabaseWorkspaceSnapshot, SharedQuery } from '../shared/workbench.ts'
import type { ExecutionDocument } from '../shared/execution-document.ts'
import type { ExecutionType } from '../shared/execution.ts'
import type { TextEntryOptions } from './data-sources/module-types.ts'
import type { SqlTemplateStore } from './sql-template-store.ts'
import type { CatalogToolInput } from './sql-catalog-operation.ts'
import type { RedisReadTool } from './data-sources/redis/read-operation.ts'

export interface AiConnectionPort {
  list(owner: string): Connection[]
  restoreRemembered(owner: string): Promise<void>
}
export interface AiDocumentPort extends AiConnectionPort {
  getExecutionDocument(owner: string, id: string, generation?: unknown): ExecutionDocument
  updateExecutionDocument(owner: string, id: string, text: string, source: 'ai' | 'user' | 'system', expectedRevision?: number, generation?: unknown, context?: unknown): ExecutionDocument
  executeText(owner: string, id: string, generation: unknown, text: unknown, signal?: AbortSignal, actor?: 'user' | 'ai', callId?: string, revision?: number, rootCallId?: string, context?: unknown, options?: { type?: ExecutionType; sql?: TextEntryOptions }): Promise<Record<string, unknown>>
}
export interface RedisAiPort extends AiDocumentPort {
  executeRedisReadTool(owner: string, id: string, generation: unknown, operation: RedisReadTool, input: Record<string, unknown>, signal?: AbortSignal, callId?: string, rootCallId?: string): Promise<Record<string, unknown>>
}
export interface NacosAiPort extends AiConnectionPort {
  nacosRequest(owner: string, id: string, generation: unknown, action: string, input: Record<string, unknown>, actor: 'user' | 'ai', signal?: AbortSignal, callId?: string, rootCallId?: string): Promise<unknown>
}
export interface SqlAiPort extends AiDocumentPort {
  readonly storageDegraded: boolean
  readonly templates: Pick<SqlTemplateStore, 'list' | 'get' | 'search' | 'publishFromSql' | 'libraryCount' | 'getTidy' | 'proposeTidy' | 'searchKnowledge' | 'getKnowledge' | 'publishKnowledge' | 'clusterKnowledge' | 'clusterPublished'>
  snapshot(owner: string): DatabaseWorkspaceSnapshot
  importConnections(owner: string, items: unknown): { created: Connection[]; skipped: unknown[] }
  getSharedQuery(owner: string, id: string): SharedQuery
  runSharedQuery(owner: string, input: { connectionId: string; generation: unknown; schema: string; sql: string; revision?: number; initiator: 'ai' | 'user'; callId?: string; rootCallId?: string; limit?: number; purpose?: string }, signal?: AbortSignal): Promise<Record<string, unknown>>
  executeCatalogTool(owner: string, id: string, generation: unknown, input: CatalogToolInput, signal?: AbortSignal, callId?: string, rootCallId?: string): Promise<Record<string, unknown>>
}
/** Composition supplies the intersection; each module sees only its own capabilities. */
export type SourceAiPort = SqlAiPort & RedisAiPort & NacosAiPort

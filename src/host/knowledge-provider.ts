import type { DataSourceId } from '../shared/data-sources/types.ts'
import type { SqlTemplate } from './sql-template-store.ts'
import type { KnowledgeClusterGroup, KnowledgeItem, KnowledgeTidyBatch } from '../shared/knowledge.ts'

export interface SqlKnowledgePort {
  get(id: string, publishedOnly?: boolean): SqlTemplate | undefined
  dispatch(body: Record<string, unknown>): Promise<unknown>
}
export interface CommandKnowledgePort {
  searchKnowledge(sourceId: DataSourceId, connectionId: string, query?: string): KnowledgeItem[]
  getKnowledge(sourceId: DataSourceId, id: string, connectionId: string): KnowledgeItem | undefined
  previewKnowledge(sourceId: DataSourceId, text: string): { fingerprint: string; analysis: KnowledgeItem['analysis']; similar: KnowledgeItem[] }
  publishKnowledge(input: { sourceId: DataSourceId; connectionId: string; text: string; title?: string; summary?: string; tags?: string[]; id?: string; expectedVersion?: number }): KnowledgeItem
  archiveKnowledge(sourceId: DataSourceId, id: string, connectionId: string, guard?: unknown): { ok: true }
  clusterKnowledge(sourceId: DataSourceId, connectionId: string): KnowledgeClusterGroup[]
  archiveKnowledgeDuplicates(sourceId: DataSourceId, connectionId: string, keepId: string, ids: string[], guards?: unknown): { ok: true; archived: string[] }
  getTidy(connectionId: string): KnowledgeTidyBatch | undefined
  applyTidy(connectionId: string, batchId: string, ids?: string[]): Promise<{ applied: string[]; failed: { id: string; message: string }[]; remaining: number }>
  rejectTidy(connectionId: string, batchId: string, ids?: string[]): { remaining: number }
}
export type KnowledgeStorePort = SqlKnowledgePort & CommandKnowledgePort

export type KnowledgeProvider<Id extends string = DataSourceId, Store = KnowledgeStorePort> = {
  id: Id
  dispatch(store: Store, connectionId: string, body: Record<string, unknown>): Promise<unknown> | unknown
}

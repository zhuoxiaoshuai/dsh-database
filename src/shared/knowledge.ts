import type { DataSourceId } from './data-sources/types.ts'

/** Saved text is never executed by opening an item. Execution uses the source's normal policy again. */
export type KnowledgeItem = {
  id: string
  familyId: string
  sourceId: DataSourceId
  connectionId: string
  text: string
  title: string
  summary: string
  tags: string[]
  fingerprint: string
  version: number
  archived: boolean
  updatedAt: string
  analysis: { operation: string; risk: string; semantic: boolean }
}

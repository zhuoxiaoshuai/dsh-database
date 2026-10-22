import type { DataSourceId } from './data-sources/types.ts'

export type KnowledgeArchiveGuard = { expectedVersion: number; expectedContentToken: string }
export type KnowledgeArchiveTarget = { id: string; archiveGuard: KnowledgeArchiveGuard }

/** Saved text is never executed by opening an item. Execution uses the source's normal policy again. */
export type KnowledgeItem = {
  archiveGuard?: KnowledgeArchiveGuard
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

export type KnowledgeClusterMember = {
  archiveGuard: KnowledgeArchiveGuard
  id: string
  title: string
  summary: string
  version: number
  text: string
}

export type KnowledgeClusterGroup = {
  fingerprint: string
  keepId: string
  count: number
  members: KnowledgeClusterMember[]
}

export type KnowledgeTidyRisk = 'same' | 'executable-changed'

export type KnowledgeTidySnapshot = {
  title: string
  summary: string
  tags: string[]
  text: string
}

export type KnowledgeTidyChange = {
  id: string
  kind: 'update' | 'archive'
  expectedVersion: number
  before: KnowledgeTidySnapshot
  after?: KnowledgeTidySnapshot
  risk: KnowledgeTidyRisk
  archiveTargets?: { id: string; expectedVersion: number; before: KnowledgeTidySnapshot }[]
}

export type KnowledgeTidyBatch = {
  id: string
  connectionId: string
  sourceId: DataSourceId
  createdAt: string
  changes: KnowledgeTidyChange[]
}

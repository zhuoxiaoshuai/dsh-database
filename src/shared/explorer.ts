import type { DataSourceId } from './data-sources/types.ts'

export type ExplorerNode = {
  ref: string
  title: string
  kind: string
  hasChildren: boolean
  metadata?: Record<string, unknown>
}

export type ExplorerPage = {
  sourceId: DataSourceId
  nodes: ExplorerNode[]
  nextCursor?: string
  complete: boolean
  warning?: string
  collectedAt?: string
}

export type ExplorerListInput = { parent?: string; cursor?: string; search?: string; refresh?: boolean; database?: string }
export type ExplorerReadInput = { ref: string; cursor?: string; offset?: number; database?: string; refresh?: boolean }

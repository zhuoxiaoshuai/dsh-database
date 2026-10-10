import type React from 'react'
import type { Connection, WorkspaceBridge } from '../../shared/workbench.ts'
import type { DataSourceId } from '../../shared/data-sources/types.ts'
import type { KafkaClientDescriptor, NacosClientDescriptor, RedisClientDescriptor, SqlClientDescriptor } from '../../shared/data-sources/types.ts'
import type { ConnectionFormSource } from '../workspace/connection/connection-form-types.ts'
import type { WorkspaceSourceContext } from '../workspace-sources.tsx'
import type { SourceWorkspaceProps } from '../workspace/source/source-workspace.tsx'
import type { ExecutionRecord } from '../../shared/execution.ts'
import type { ExecutionResultEnvelope } from '../../shared/execution-result.ts'

export type CatalogRoot = { id: string; label: string }

export type SourceLogo = {
  viewBox: string
  className?: string
  artwork: React.ReactNode
  compact?: { viewBox: string; artwork: React.ReactNode }
}

type ClientSourceBase = {
  id: DataSourceId
  descriptor: SqlClientDescriptor | RedisClientDescriptor | KafkaClientDescriptor | NacosClientDescriptor
  connection: ConnectionFormSource
  logo: SourceLogo
  tree?: { render?: React.ComponentType<{bridge: WorkspaceBridge; connection: Connection; onSelect(id: string): void; selectedId?: string; refreshToken?: number}>; roots?: readonly CatalogRoot[]; nodes?(connection: Connection): readonly CatalogRoot[]; filterNoun?: string }
  history?: HistoryDetailSource
}

type SourceBindings<T> = T extends unknown ? Omit<T, 'bridge' | 'connection' | 'navigation'> : never
export type StandardSourceBindings = SourceBindings<SourceWorkspaceProps>
export type HistoryDetailSource = {
  id: DataSourceId
  legacyHistoryVisible?(record: ExecutionRecord): boolean
  renderText(record: ExecutionRecord, onUse?: (text: string, schema?: string) => void): React.ReactNode
  resultEnvelope(record: ExecutionRecord, value: unknown): ExecutionResultEnvelope
  renderResult(envelope: ExecutionResultEnvelope): React.ReactNode
}
export type ClientSourceModule = ClientSourceBase & {
  workspace: { mode: 'standard'; useBindings(context: WorkspaceSourceContext): StandardSourceBindings }
}

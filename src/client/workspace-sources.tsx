import React from 'react'
import type { Connection, ConnectionWorkbench, PendingSchemaPick, WorkspaceBridge } from '../shared/workbench.ts'
import type { DataSourceId } from '../shared/data-sources/types.ts'
import { supportedAllDataSources } from '../shared/data-sources/registry.ts'
import { createWorkspaceRegistry, type WorkspaceRegistration } from './workspace/parts/workspace-registry.ts'
import type { SchemaCache } from './schema/schema-cache.ts'
import type { TreePaneActions } from './tree-pane-actions.ts'
import type { TreeFocus } from './tree-focus.ts'
import { clientModules } from './data-sources/registry.ts'
import type { ClientSourceModule } from './data-sources/types.ts'
import { SourceWorkspace } from './workspace/source/source-workspace.tsx'

export type WorkspaceSourceContext = {
  conversationId: string
  host: WorkspaceBridge
  connection: Connection
  connections: Connection[]
  cache: SchemaCache
  pendingRef: React.MutableRefObject<PendingSchemaPick | undefined>
  sqlCacheRef: React.MutableRefObject<Map<string, { id: string; name: string; sql: string }[]>>
  actionsRef: React.MutableRefObject<TreePaneActions | undefined>
  refreshToken: number
  catalogRoot: string
  onPick(id: string): void
  onWorkbench?(id: string, patch: ConnectionWorkbench): void
  onSchema(schema: string): void
  onTreeBusy(busy: boolean): void
  onTreeFocus(next?: TreeFocus): void
}

export type WorkspaceSource = WorkspaceRegistration<DataSourceId, WorkspaceSourceContext, React.ReactElement>

export function StandardSourceMount({ module, context }: { module: Extract<ClientSourceModule, { workspace: { mode: 'standard' } }>; context: WorkspaceSourceContext }) {
  const bindings = module.workspace.useBindings(context)
  return <SourceWorkspace bridge={context.host} connection={context.connection} {...bindings} />
}

export const workspaceSources = createWorkspaceRegistry(clientModules.ids().map(id => {
  const module = clientModules.get(id)
  return { id, render: (context: WorkspaceSourceContext) => module.workspace.mode === 'standard'
    ? <StandardSourceMount module={module as Extract<ClientSourceModule, { workspace: { mode: 'standard' } }>} context={context} />
    : module.workspace.render(context) }
}), supportedAllDataSources)

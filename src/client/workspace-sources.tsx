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
import { useWorkspaceNavigation, type WorkspaceNavigation } from './workspace/source/workspace-navigation.ts'

export type WorkspaceSourceContext = {
  navigation?: WorkspaceNavigation
  conversationId: string
  host: WorkspaceBridge
  connection: Connection
  connections: Connection[]
  sql?: ReturnType<typeof import('./sql/catalog-controller.ts').useSqlCatalogController>
  refreshToken: number
  catalogRoot: string
  onCatalogRoot?(id: string): void
  onPick(id: string): void
  onWorkbench?(id: string, patch: ConnectionWorkbench): void

}

export type WorkspaceSource = WorkspaceRegistration<DataSourceId, WorkspaceSourceContext, React.ReactElement>

export function StandardSourceMount({ module, context }: { module: ClientSourceModule; context: WorkspaceSourceContext }) {
  const navigation = useWorkspaceNavigation()
  const bindings = module.workspace.useBindings({ ...context, navigation })
  return <SourceWorkspace bridge={context.host} connection={context.connection} navigation={navigation} {...bindings} />
}

export const workspaceSources = createWorkspaceRegistry(clientModules.ids().map(id => {
  const module = clientModules.get(id)
  return { id, render: (context: WorkspaceSourceContext) => <StandardSourceMount module={module} context={context} /> }
}), supportedAllDataSources)

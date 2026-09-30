import React, { useEffect, useState } from 'react'
import { Cylinder, Eye } from 'lucide-react'
import { TreeBranch } from './workspace/tree/tree-branch.tsx'
import { TreeRetryHint, TreeTypeIcon } from './workspace/tree/tree-loading-icon.tsx'
import { refreshCatalogLayer } from './schema/refresh.ts'
import type { SchemaCache } from './schema/schema-cache.ts'
import type { Connection } from '../shared/workbench.ts'
import { TableTreeNode } from './table-tree-node.tsx'
import { isTreeFocusSelected, type TreeFocus } from './tree-focus.ts'

type ObjectKind = 'table' | 'view'

export function SchemaTreeNode({
  name, connection, cache, active, search, treeFocus,
  onActivate, onShowHomeFolder, onFocus, onHighlight, onSyncListHighlight, onOpen, onMenu,
}: {
  name: string
  connection: Connection
  cache: SchemaCache
  active: boolean
  search: string
  treeFocus?: TreeFocus
  onActivate(): void
  onShowHomeFolder(kind: ObjectKind): void
  onFocus(next: TreeFocus): void
  onHighlight(name: string, kind: ObjectKind): void
  onSyncListHighlight(name: string, kind: ObjectKind): void
  onOpen(schemaName: string, tableName: string, kind: ObjectKind): void
  onMenu(event: React.MouseEvent, schemaName: string, tableName: string, kind: ObjectKind): void
}) {
  const [open, setOpen] = useState(false)
  const [viewsOpen, setViewsOpen] = useState(false)
  const objects = cache.tablesSnapshot(connection, name) || []
  const status = cache.tablesStatus(connection, name)
  const needle = search.trim().toLocaleLowerCase()
  const match = (value: string) => !needle || value.toLocaleLowerCase().includes(needle)
  const tables = objects.filter(item => item.kind === 'table' && match(item.name))
  const views = objects.filter(item => item.kind === 'view' && match(item.name))
  const tablesLoading = status?.status === 'loading'
  const tablesError = status?.status === 'error' ? status.error : ''
  const live = !!connection.live

  useEffect(() => {
    if (!open || !live) return
    const controller = new AbortController()
    void cache.loadTables(connection, name, { signal: controller.signal }).catch(() => {})
    return () => controller.abort()
  }, [open, live, connection.id, connection.generation, cache, name])

  const tableNode = (item: { name: string }, objectKind: ObjectKind) => <TableTreeNode
    key={`${objectKind}:${item.name}`}
    schemaName={name}
    tableName={item.name}
    objectKind={objectKind}
    connection={connection}
    cache={cache}
    treeFocus={treeFocus}
    onFocus={onFocus}
    onHighlight={onHighlight}
    onSyncListHighlight={onSyncListHighlight}
    onOpen={onOpen}
    onMenu={onMenu}
  />

  return <TreeBranch
    className="db-schema-node"
    expanded={open}
    selected={isTreeFocusSelected(treeFocus, `schema:${name}`)}
    showTwist={live}
    twistLabel={open ? `折叠 ${name}` : `展开 ${name}`}
    onToggle={() => setOpen(value => !value)}
    onSelect={() => {
      onActivate()
      onFocus({ kind: 'schema', schema: name })
    }}
    row={<>
      <TreeTypeIcon loading={open && tablesLoading} loadingLabel="正在读取表和视图">
        <Cylinder size={14} className={`db-tree-icon db-tree-icon-schema ${active ? 'is-current' : ''}`} />
      </TreeTypeIcon>
      <span className="db-tree-label">{name}</span>
    </>}
  >
    {tables.map(table => tableNode(table, 'table'))}
    {tablesLoading && !tables.length && <p className="db-muted db-tree-hint">正在读取表…</p>}
    {tablesError && <TreeRetryHint text={tablesError} onRetry={() => { void refreshCatalogLayer(cache, connection, { layer: 'database', schema: name }).catch(() => {}) }} />}
    {!tablesLoading && !tablesError && !tables.length && <p className="db-muted db-tree-hint">没有匹配的表</p>}
    {views.length > 0 && <TreeBranch
      className="db-view-group"
      expanded={viewsOpen}
      selected={isTreeFocusSelected(treeFocus, `folder:${name}:view`)}
      twistLabel={viewsOpen ? '折叠视图' : '展开视图'}
      onToggle={() => setViewsOpen(value => !value)}
      onSelect={() => {
        onActivate()
        onShowHomeFolder('view')
      }}
      row={<>
        <Eye size={14} className="db-tree-icon db-tree-icon-view" />
        <span className="db-tree-label">视图</span>
      </>}
    >
      {views.map(view => tableNode(view, 'view'))}
    </TreeBranch>}
  </TreeBranch>
}

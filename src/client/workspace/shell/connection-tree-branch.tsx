import React, { useEffect } from 'react'
import { Copy, Ellipsis, Pencil, Plug, Power, RefreshCw, Settings2, Trash2 } from 'lucide-react'
import { TreeBranch } from '../tree/tree-branch.tsx'
import { TreeLoadingIcon, TreeRetryHint, TreeTypeIcon } from '../tree/tree-loading-icon.tsx'
import { SchemaTreeNode } from '../../schema-tree-node.tsx'
import { refreshCatalogLayer } from '../../schema/refresh.ts'
import type { SchemaCache } from '../../schema/schema-cache.ts'
import type { TreeFocus } from '../../tree-focus.ts'
import { catalogSchemaName, visibleCatalogChildren, type Connection } from '../../../shared/workbench.ts'
import { dialectCapabilities } from '../../../shared/dialect-capabilities.ts'
import { useDelayedClickDismiss } from '../parts/use-delayed-click-dismiss.ts'
import { DialectLogo } from './dialect-logo.tsx'
import { clientWorkspaceDescriptor } from '../../../shared/data-sources/registry.ts'
import { clientModules } from '../../data-sources/registry.ts'
import { CatalogRootNode } from './catalog-root-node.tsx'
import { catalogFilterCopy, sqlCatalogFilterCopy } from './catalog-filter-copy.ts'

type ObjectKind = 'table' | 'view'

export function ConnectionTreeBranch({
  item, selected, connecting, actionBlocked, treeBusy, search, schema, catalogRoot, cache, treeFocus, expanded, overflow,
  onPick, onConnect, onEdit, onCopy, onDisconnect, onDelete, onToggleExpanded, onRefresh, onFilter, onActivateRoot, onActivateSchema, onShowHomeFolder, onFocus, onHighlight, onSyncListHighlight, onOpen, onMenu, onOpenOverflow, onCloseOverflow,
}: {
  item: Connection
  selected: boolean
  connecting: boolean
  actionBlocked?: string
  treeBusy: boolean
  search: string
  schema: string
  catalogRoot: string
  cache: SchemaCache
  treeFocus?: TreeFocus
  expanded: boolean
  overflow?: { x: number; y: number }
  onPick(): void
  onConnect(): void
  onEdit(): void
  onCopy?(): void
  onDisconnect?(): void
  onDelete?(): void
  onToggleExpanded(): void
  onRefresh(): void
  onFilter(): void
  onActivateRoot(id: string): void
  onActivateSchema(name: string): void
  onShowHomeFolder(schemaName: string, kind: ObjectKind): void
  onFocus(next: TreeFocus): void
  onHighlight(name: string, kind: ObjectKind): void
  onSyncListHighlight(name: string, kind: ObjectKind): void
  onOpen(schemaName: string, tableName: string, kind: ObjectKind): void
  onMenu(event: React.MouseEvent, schemaName: string, tableName: string, kind: ObjectKind): void
  onOpenOverflow(next: { x: number; y: number }): void
  onCloseOverflow(): void
}): React.ReactElement {
  const showsSchemaTree = clientWorkspaceDescriptor(item.dialect).showsSchemaTree
  const tree = clientModules.get(item.dialect).tree
  const catalogRoots = tree?.nodes?.(item) ?? tree?.roots ?? []
  const open = (showsSchemaTree || catalogRoots.length > 0) && expanded && !!item.live
  const schemas = showsSchemaTree ? cache.schemasSnapshot(item) || [] : []
  const schemasStatus = cache.schemasStatus(item)
  const schemasBusy = schemasStatus?.status === 'loading'
  const schemasError = schemasStatus?.status === 'error' ? schemasStatus.error : ''
  useDelayedClickDismiss(!!overflow, onCloseOverflow)
  useEffect(() => {
    if (!showsSchemaTree || !item.live || !open) return
    const controller = new AbortController()
    void cache.loadSchemas(item, { signal: controller.signal }).catch(() => {})
    return () => controller.abort()
  }, [cache, item.id, item.generation, item.live, open, showsSchemaTree])

  const ignoreCase = showsSchemaTree ? dialectCapabilities(item.dialect).namespaceCaseInsensitive : false
  const filterNoun = showsSchemaTree ? sqlCatalogFilterCopy.noun : (tree?.filterNoun || '项')
  const canFilterChildren = showsSchemaTree || catalogRoots.length > 0
  const schemaChildren = schemas.flatMap(row => {
    const name = catalogSchemaName(row)
    return name ? [{ id: name, label: name }] : []
  })
  const visibleSchemas = visibleCatalogChildren(schemaChildren, item.workbench?.visibleSchemas, { currentId: schema, search, caseInsensitive: ignoreCase })
  const visibleRoots = visibleCatalogChildren(catalogRoots, item.workbench?.visibleSchemas, { currentId: catalogRoot, search })
  const blocked = connecting || !!actionBlocked

  return <div className={`db-tree-conn-row db-tree-conn-${item.dialect}`}>
    <TreeBranch
      className="db-tree-conn"
      expanded={open}
      selected={selected}
      showTwist={(showsSchemaTree || catalogRoots.length > 0) && !!item.live}
      twistLabel={open ? `折叠 ${item.name}` : `展开 ${item.name}`}
      onToggle={onToggleExpanded}
      onSelect={() => onPick()}
      onMouseDown={event => { if (event.detail > 1) event.preventDefault() }}
      onDoubleClick={event => {
        event.preventDefault()
        window.getSelection()?.removeAllRanges()
        if (!item.live && !connecting) onConnect()
      }}
      onContextMenu={event => {
        event.preventDefault()
        onPick()
        onOpenOverflow({ x: event.clientX, y: event.clientY })
      }}
      row={<>
        {connecting
          ? <TreeLoadingIcon label="正在连接" />
          : <span className={`db-tree-status ${item.live ? 'is-live' : 'is-off'}`} title={item.live ? '已连接' : '未连接'} />}
        <span className="db-tree-dialect-mark">
          <TreeTypeIcon loading={showsSchemaTree && schemasBusy && !connecting} loadingLabel="正在读取数据库列表">
            <DialectLogo dialect={item.dialect} className="db-tree-dialect" />
          </TreeTypeIcon>
          <span className="db-tree-dialect-name">{clientWorkspaceDescriptor(item.dialect).displayName}</span>
        </span>
        <span className="db-tree-label">{item.name}</span>
        {connecting && <small>连接中</small>}
      </>}
    >
      {visibleRoots.map(root => <CatalogRootNode key={root.id} label={root.label} selected={selected && catalogRoot === root.id} onSelect={() => onActivateRoot(root.id)} />)}
      {visibleSchemas.map(row => {
        const name = row.id
        return <SchemaTreeNode
          key={name}
          name={name}
          connection={item}
          cache={cache}
          active={selected && schema === name}
          search={search}
          treeFocus={treeFocus}
          onActivate={() => onActivateSchema(name)}
          onShowHomeFolder={kind => onShowHomeFolder(name, kind)}
          onFocus={onFocus}
          onHighlight={(tableName, kind) => { onActivateSchema(name); onHighlight(tableName, kind) }}
          onSyncListHighlight={(tableName, kind) => { onActivateSchema(name); onSyncListHighlight(tableName, kind) }}
          onOpen={onOpen}
          onMenu={onMenu}
        />
      })}
      {schemasBusy && !visibleSchemas.length && <p className="db-muted db-tree-hint">正在读取数据库…</p>}
      {schemasError && <TreeRetryHint text={schemasError} onRetry={() => { onPick(); void refreshCatalogLayer(cache, item, { layer: 'connection' }).catch(() => {}) }} />}
      {showsSchemaTree && !schemasBusy && !schemasError && !visibleSchemas.length && <p className="db-muted db-tree-hint">{sqlCatalogFilterCopy.emptyTree}</p>}
      {!showsSchemaTree && open && catalogRoots.length > 0 && !visibleRoots.length && <p className="db-muted db-tree-hint">{catalogFilterCopy(filterNoun).emptyTree}</p>}
    </TreeBranch>
    <div className="db-tree-conn-actions">
      {item.live
        ? <button type="button" className="db-icon-button" disabled={connecting || (selected && treeBusy)} aria-label={`刷新 ${item.name}`} title="刷新" onClick={() => { onPick(); if (showsSchemaTree) void refreshCatalogLayer(cache, item, { layer: 'connection' }).catch(() => {}); else onRefresh() }}><RefreshCw size={12} className={(connecting || (selected && treeBusy) || schemasBusy) ? 'db-spin' : undefined} /></button>
        : <button type="button" className="db-icon-button" disabled={connecting} aria-label={`连接 ${item.name}`} title="连接" onClick={() => { onPick(); onConnect() }}><Plug size={12} /></button>}
      <button type="button" className="db-icon-button" aria-label={`更多 ${item.name} 操作`} title="更多" onClick={event => { event.stopPropagation(); onPick(); onOpenOverflow({ x: event.clientX, y: event.clientY }) }}><Ellipsis size={12} /></button>
    </div>
    {overflow && <div className="db-dropdown db-context-menu" style={{ position: 'fixed', left: overflow.x, top: overflow.y }} role="menu" onClick={event => event.stopPropagation()}>
      {!item.live && <button type="button" disabled={connecting} onClick={() => { onCloseOverflow(); onConnect() }}><Plug size={12} />连接</button>}
      {canFilterChildren && <button type="button" onClick={() => { onCloseOverflow(); onFilter() }}><Settings2 size={12} />显示的{filterNoun}</button>}
      <button type="button" onClick={() => { onCloseOverflow(); onEdit() }}><Pencil size={12} />编辑</button>
      <button type="button" onClick={() => { onCloseOverflow(); onCopy?.() }}><Copy size={12} />复制连接</button>
      {item.live && <button type="button" disabled={blocked} title={actionBlocked} onClick={() => { onCloseOverflow(); onDisconnect?.() }}><Power size={12} />断开</button>}
      <button type="button" disabled={blocked} title={actionBlocked} onClick={() => { onCloseOverflow(); onDelete?.() }}><Trash2 size={12} />删除</button>
    </div>}
  </div>
}

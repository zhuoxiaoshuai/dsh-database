import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderTree, Plus, Search, X } from 'lucide-react'
import { SchemaCache } from '../../schema/schema-cache.ts'
import { ConnectionTreeBranch } from './connection-tree-branch.tsx'
import { PaneGutter, PANE_GUTTER } from './pane-gutter.tsx'
import { workspaceSources } from '../../workspace-sources.tsx'
import { clientModules } from '../../data-sources/registry.ts'
import type { TreePaneActions } from '../../tree-pane-actions.ts'
import type { TreeFocus } from '../../tree-focus.ts'
import { useDragResize } from '../parts/use-drag-resize.ts'
import { coerceVisibleSchemas, preferredCatalogRoot, schemaCatalogChildren, type Connection, type ConnectionWorkbench, type PendingSchemaPick, type WorkspaceBridge } from '../../../shared/workbench.ts'
import { connectionIdOf, errorCodeOf, isAbortError, shouldMarkConnectionOffline } from '../../../shared/connection-errors.ts'
import { clientWorkspaceDescriptor } from '../../../shared/data-sources/registry.ts'
import { dialectCapabilities } from '../../../shared/dialect-capabilities.ts'
import { catalogFilterCopy, sqlCatalogFilterCopy } from './catalog-filter-copy.ts'
import { VisibleCatalogDialog } from './visible-catalog-dialog.tsx'

function catalogChildren(item: Connection) {
  const tree = clientModules.get(item.dialect).tree
  return [...(tree?.nodes?.(item) ?? tree?.roots ?? [])]
}

export function WorkbenchShell({
  bridge, conversationId, connection, connections, reconnecting, onPick, onAdd, onEdit, onCopy, onConnect, onDisconnect, onDelete, onUnavailable, onWorkbench,
}: {
  bridge: WorkspaceBridge
  conversationId: string
  connection: Connection
  connections: Connection[]
  reconnecting?: string
  onPick(id: string): void
  onAdd(): void
  onEdit(id: string): void
  onCopy?(id: string): void
  onConnect?(id: string): void
  onDisconnect?(id: string): void
  onDelete?(id: string): void
  onUnavailable?(message: string, connectionId?: string): void
  onWorkbench?(id: string, patch: ConnectionWorkbench): void
}) {
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const [sideWidth, setSideWidth] = useState(220)
  const [expandedIds, setExpandedIds] = useState<string[]>(() => connections.filter(item => item.live).map(item => item.id))
  const [cacheTick, setCacheTick] = useState(0)
  const [schema, setSchema] = useState(connection.workbench?.schema || '')
  const [catalogRoot, setCatalogRoot] = useState(() => preferredCatalogRoot(catalogChildren(connection), '', connection.workbench?.visibleSchemas))
  const [treeBusy, setTreeBusy] = useState(false)
  const [treeFocus, setTreeFocus] = useState<TreeFocus | undefined>()
  const [filterTarget, setFilterTarget] = useState<string>()
  const [filterDraft, setFilterDraft] = useState<string[]>([])
  const [filterSearch, setFilterSearch] = useState('')
  const [sourceRefresh, setSourceRefresh] = useState<Record<string, number>>({})
  const [connectionMenu, setConnectionMenu] = useState<{ id: string; x: number; y: number }>()
  const pendingRef = useRef<PendingSchemaPick | undefined>()
  const sqlCacheRef = useRef(new Map<string, { id: string; name: string; sql: string }[]>())
  const actionsRef = useRef<TreePaneActions | undefined>()
  const liveSeen = useRef(new Set(connections.filter(item => item.live).map(item => item.id)))
  const onUnavailableRef = useRef(onUnavailable)
  onUnavailableRef.current = onUnavailable
  const host = useMemo(() => {
    const wrap = <T,>(item: Connection, run: () => Promise<T>) => run().catch(error => {
      const message = error instanceof Error ? error.message : '读取失败'
      const code = errorCodeOf(error)
      if (item.live && !isAbortError(error) && shouldMarkConnectionOffline(code, message)) onUnavailableRef.current?.(message, connectionIdOf(error) || item.id)
      throw error instanceof Error ? error : new Error(message)
    })
    const explorer = bridge.explorer
    return {
      ...bridge,
      catalog: (item: Connection, input: Parameters<NonNullable<WorkspaceBridge['catalog']>>[1], signal?: AbortSignal) => wrap(item, () => bridge.catalog!(item, input, signal)),
      browse: (item: Connection, input: Parameters<NonNullable<WorkspaceBridge['browse']>>[1], signal?: AbortSignal) => wrap(item, () => bridge.browse!(item, input, signal)),
      execute: (item: Connection, sql: string, signal: AbortSignal) => wrap(item, () => bridge.execute(item, sql, signal)),
      executeManual: (item: Connection, sql: string, signal: AbortSignal) => wrap(item, () => (bridge.executeManual || bridge.execute)(item, sql, signal)),
      maintenance: (item: Connection, input: Record<string, unknown>) => wrap(item, () => bridge.maintenance!(item, input)),
      ...(bridge.executeText ? { executeText: (item: Connection, text: string, context?: Record<string, string>, signal?: AbortSignal) => wrap(item, () => bridge.executeText!(item, text, context, signal)) } : {}),
      ...(bridge.redis ? { redis: (item: Connection, action: Parameters<NonNullable<WorkspaceBridge['redis']>>[1], input: Record<string, unknown>, signal?: AbortSignal) => wrap(item, () => bridge.redis!(item, action, input, signal)) } : {}),
      ...(explorer ? { explorer: ((item: Connection, action: 'list' | 'read', input: object, signal?: AbortSignal) => wrap(item, () => (explorer as (connection: Connection, action: 'list' | 'read', input: object, signal?: AbortSignal) => Promise<unknown>)(item, action, input, signal))) as NonNullable<WorkspaceBridge['explorer']> } : {}),
    }
  }, [bridge])
  const catalogRef = useRef(host.catalog)
  catalogRef.current = host.catalog
  const stableCatalog = useCallback((item: Connection, input: Parameters<NonNullable<WorkspaceBridge['catalog']>>[1], signal?: AbortSignal) => catalogRef.current!(item, input, signal), [])
  const cache = useMemo(() => new SchemaCache(stableCatalog), [stableCatalog])
  useEffect(() => cache.subscribe(() => setCacheTick(n => n + 1)), [cache])
  useEffect(() => {
    setExpandedIds(ids => {
      let next = ids.filter(id => connections.some(item => item.id === id && item.live))
      for (const item of connections) {
        if (item.live && !liveSeen.current.has(item.id)) {
          liveSeen.current.add(item.id)
          if (!next.includes(item.id)) next = [...next, item.id]
        }
        if (!item.live) liveSeen.current.delete(item.id)
      }
      return next
    })
  }, [connections])
  useEffect(() => {
    const roots = catalogChildren(connection)
    setCatalogRoot(current => preferredCatalogRoot(roots, current, connection.workbench?.visibleSchemas))
  }, [connection.id, connection.dialect, connection.generation, connection.databases, connection.workbench?.visibleSchemas])
  const onSchema = useCallback((next: string) => setSchema(next), [])
  const onTreeBusy = useCallback((busy: boolean) => setTreeBusy(busy), [])
  const onTreeFocus = useCallback((next?: TreeFocus) => setTreeFocus(next), [])
  const match = (name: string) => !search.trim() || name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  const visibleConnections = connections.filter(item => match(item.name) || item.id === connection.id)
  const visibleConnectionIds = visibleConnections.map(item => item.id).join('\0')
  useEffect(() => { if (collapsed) setConnectionMenu(undefined) }, [collapsed])
  useEffect(() => {
    setConnectionMenu(current => current && visibleConnectionIds.split('\0').includes(current.id) ? current : undefined)
  }, [visibleConnectionIds])
  const filterConnection = filterTarget ? connections.find(item => item.id === filterTarget) : undefined
  const filterItems = useMemo(() => {
    if (!filterConnection) return []
    if (clientWorkspaceDescriptor(filterConnection.dialect).showsSchemaTree) return schemaCatalogChildren(cache.schemasSnapshot(filterConnection) || [])
    return catalogChildren(filterConnection)
  }, [cache, cacheTick, filterConnection])
  const filterCopy = filterConnection && !clientWorkspaceDescriptor(filterConnection.dialect).showsSchemaTree
    ? catalogFilterCopy(clientModules.get(filterConnection.dialect).tree?.filterNoun || '项')
    : sqlCatalogFilterCopy
  const filterCaseInsensitive = !!filterConnection && clientWorkspaceDescriptor(filterConnection.dialect).showsSchemaTree && dialectCapabilities(filterConnection.dialect).namespaceCaseInsensitive
  const startResize = useDragResize((start, next) => {
    setSideWidth(Math.min(420, Math.max(160, sideWidth + (next.clientX - start.clientX))))
  })
  const useConnection = (item: Connection, schemaName?: string, extra?: Pick<PendingSchemaPick, 'folder' | 'open'>) => {
    const selected = item.id === connection.id
    if (schemaName || extra) pendingRef.current = { connectionId: item.id, schema: schemaName || '', ...extra }
    if (!selected) onPick(item.id)
    else if (schemaName) actionsRef.current?.activateSchema(schemaName)
  }
  return <section className="db-shell" aria-label="数据库工作台">
    <div className="db-shell-body">
      <aside className={`db-object-sidebar ${collapsed ? 'is-collapsed' : ''}`} style={collapsed ? { width: PANE_GUTTER } : { width: sideWidth }} aria-label="我的连接">
        {!collapsed && <div className="db-sidebar-toolbar">
          <div className="db-catalog-search"><Search size={15} /><input aria-label="搜索连接或对象" placeholder="搜索" value={search} onChange={e => setSearch(e.target.value)} />{search && <button className="db-icon-button" aria-label="清空搜索" onClick={() => setSearch('')}><X size={12} /></button>}</div>
        </div>}
        {!collapsed && <div className="db-object-tree db-conn-tree" onMouseDown={event => { if (event.detail > 1) event.preventDefault() }}>
          <strong>
            <FolderTree size={14} className="db-tree-icon" />我的连接
            <button type="button" className="db-icon-button" aria-label="新建连接" onClick={onAdd}><Plus size={14} /></button>
          </strong>
          {visibleConnections.map(item => {
            const connecting = reconnecting === item.id
            const selected = item.id === connection.id
            return <ConnectionTreeBranch
              key={item.id}
              item={item}
              selected={selected}
              connecting={connecting}
              actionBlocked={reconnecting === item.id ? '连接正在处理请求，暂时不能断开或删除。' : undefined}
              treeBusy={selected && treeBusy}
              search={search}
              schema={selected ? schema : ''}
              cache={cache}
              treeFocus={selected ? treeFocus : undefined}
              expanded={expandedIds.includes(item.id)}
              overflow={connectionMenu?.id === item.id ? { x: connectionMenu.x, y: connectionMenu.y } : undefined}
              onPick={() => { pendingRef.current = undefined; onPick(item.id) }}
              onConnect={() => onConnect?.(item.id)}
              onEdit={() => onEdit(item.id)}
              onCopy={() => onCopy?.(item.id)}
              onDisconnect={() => onDisconnect?.(item.id)}
              onDelete={() => onDelete?.(item.id)}
              onToggleExpanded={() => setExpandedIds(ids => ids.includes(item.id) ? ids.filter(id => id !== item.id) : [...ids, item.id])}
              onRefresh={() => {
                setSourceRefresh(previous => ({ ...previous, [item.id]: (previous[item.id] || 0) + 1 }))
              }}
              onFilter={() => {
                pendingRef.current = undefined
                if (!selected) onPick(item.id)
                setFilterDraft(coerceVisibleSchemas(item.workbench?.visibleSchemas))
                setFilterSearch('')
                setFilterTarget(item.id)
              }}
              catalogRoot={selected ? catalogRoot : ''}
              onActivateRoot={id => {
                pendingRef.current = undefined
                setCatalogRoot(id)
                if (!selected) onPick(item.id)
              }}
              onActivateSchema={name => useConnection(item, name)}
              onShowHomeFolder={(schemaName, kind) => {
                useConnection(item, schemaName, { folder: kind })
                if (selected) actionsRef.current?.showHomeFolder(kind)
              }}
              onFocus={next => {
                if (next.schema) useConnection(item, next.schema)
                if (selected) actionsRef.current?.focusTree(next)
              }}
              onHighlight={(tableName, kind) => { if (selected) actionsRef.current?.highlight(tableName, kind) }}
              onSyncListHighlight={(tableName, kind) => { if (selected) actionsRef.current?.highlight(tableName, kind) }}
              onOpen={(schemaName, tableName, kind) => {
                useConnection(item, schemaName, { open: { table: tableName, kind } })
                if (selected) actionsRef.current?.openObject(schemaName, tableName, kind)
              }}
              onMenu={(event, schemaName, tableName, kind) => {
                useConnection(item, schemaName)
                if (selected) actionsRef.current?.openContextMenu(event, schemaName, tableName, kind)
              }}
              onOpenOverflow={next => setConnectionMenu({ id: item.id, x: next.x, y: next.y })}
              onCloseOverflow={() => setConnectionMenu(current => current?.id === item.id ? undefined : current)}
            />
          })}
        </div>}
        <PaneGutter
          axis="x"
          collapsed={collapsed}
          onToggle={() => setCollapsed(value => !value)}
          onExpand={() => setCollapsed(false)}
          onResize={collapsed ? undefined : startResize}
        />
      </aside>
      <div className="db-shell-pane">
        <React.Fragment key={`${conversationId}:${connection.id}`}>
        {workspaceSources.get(connection.dialect).render({
          conversationId, host, connection, connections, cache, pendingRef, sqlCacheRef, actionsRef, refreshToken: sourceRefresh[connection.id] || 0, catalogRoot, onPick, onWorkbench, onSchema, onTreeBusy, onTreeFocus,
        })}
        </React.Fragment>
      </div>
    </div>
    {filterConnection && <VisibleCatalogDialog
      open
      items={filterItems}
      draft={filterDraft}
      search={filterSearch}
      caseInsensitive={filterCaseInsensitive}
      copy={filterCopy}
      onDraft={setFilterDraft}
      onSearch={setFilterSearch}
      onClose={() => setFilterTarget(undefined)}
      onSave={() => {
        const next = coerceVisibleSchemas(filterDraft)
        onWorkbench?.(filterConnection.id, { visibleSchemas: next })
        setFilterTarget(undefined)
      }}
    />}
  </section>
}

import {WorkbenchTooltips} from '../parts/overlay/tooltip.tsx'
import {DrawerBackdrop,DrawerClose} from '../parts/layout/drawer-chrome.tsx'
import type {MenuAnchor} from '../parts/overlay/floating-surface.tsx'
import {SqlConnectionTree} from '../../sql/connection-tree.tsx'
import {refreshCatalogLayer} from '../../schema/refresh.ts'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderTree, Plus, Search, X } from 'lucide-react'
import { useSqlCatalogController } from '../../sql/catalog-controller.ts'
import { ConnectionTreeBranch } from './connection-tree-branch.tsx'
import { PaneGutter, PANE_GUTTER } from './pane-gutter.tsx'
import { workspaceSources } from '../../workspace-sources.tsx'
import { clientModules } from '../../data-sources/registry.ts'
import { useDragResize } from '../parts/hooks/use-drag-resize.ts'
import { coerceVisibleSchemas, preferredCatalogRoot, schemaCatalogChildren, type Connection, type ConnectionWorkbench, type PendingSchemaPick, type WorkspaceBridge } from '../../../shared/workbench.ts'
import { connectionIdOf, errorCodeOf, isAbortError, shouldMarkConnectionOffline } from '../../../shared/connection-errors.ts'
import { clientWorkspaceDescriptor } from '../../../shared/data-sources/registry.ts'
import { dialectCapabilities } from '../../../shared/dialect-capabilities.ts'
import { catalogFilterCopy, sqlCatalogFilterCopy } from './catalog-filter-copy.ts'
import { VisibleCatalogDialog } from './visible-catalog-dialog.tsx'
import { usePanelSize } from '../parts/hooks/use-panel-size.ts'
import { useDrawerFocus } from '../parts/overlay/use-drawer-focus.ts'

function catalogChildren(item: Connection) {
  const tree = clientModules.get(item.dialect).tree
  return [...(tree?.nodes?.(item) ?? tree?.roots ?? [])]
}

export function WorkbenchShell({
  bridge, conversationId, connection, connections, busyConnections, onPick, onAdd, onEdit, onCopy, onConnect, onCancelConnect, onDisconnect, onDelete, onUnavailable, onWorkbench,
}: {
  bridge: WorkspaceBridge
  conversationId: string
  connection: Connection
  connections: Connection[]
  busyConnections?: Set<string>
  onCancelConnect?(id: string): void
  onPick(id: string): void | boolean | Promise<void | boolean>
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
  const shellRef = useRef<HTMLElement>(null)
  const sideRef = useRef<HTMLElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const {width: shellWidth} = usePanelSize(shellRef)
  const narrow = shellWidth > 0 && shellWidth < 980
  const [drawerOpen, setDrawerOpen] = useState(false)
  const closeDrawer = () => setDrawerOpen(false)
  useDrawerFocus(narrow && drawerOpen, sideRef, triggerRef, closeDrawer)
  const [collapsed, setCollapsed] = useState(false)
  const [sideWidth, setSideWidth] = useState(220)
  const [expandedIds, setExpandedIds] = useState<string[]>(() => connections.filter(item => item.live).map(item => item.id))
  const [catalogRoots, setCatalogRoots] = useState<Record<string,string>>({})
  const catalogRoot = catalogRoots[connection.id] || preferredCatalogRoot(catalogChildren(connection), '', connection.workbench?.visibleSchemas)
  const setCatalogRoot = (root: string | ((previous:string)=>string), id=connection.id) => setCatalogRoots(old=>({...old,[id]:typeof root==='function'?root(old[id] || ''):root}))
  useEffect(()=>{setCatalogRoots(old=>Object.fromEntries(Object.entries(old).filter(([id])=>connections.some(c=>c.id===id))))},[connections])
  const [filterTarget, setFilterTarget] = useState<string>()
  const [filterDraft, setFilterDraft] = useState<string[]>([])
  const [filterSearch, setFilterSearch] = useState('')
  const [sourceRefresh, setSourceRefresh] = useState<Record<string, number>>({})
  const [connectionMenu, setConnectionMenu] = useState<MenuAnchor & {id:string}>()
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
  const sql = useSqlCatalogController(host, connection,connections)
  const {cache,cacheTick,schema,treeBusy,treeFocus,pendingRef,actionsRef,onSchema,onTreeBusy,onTreeFocus} = sql
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
    if (!clientModules.get(connection.dialect).tree?.render) setCatalogRoot(current => preferredCatalogRoot(roots, current, connection.workbench?.visibleSchemas))
  }, [connection.id, connection.dialect, connection.generation, connection.databases, connection.workbench?.visibleSchemas])
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
    setSideWidth(Math.min(320, Math.max(180, sideWidth + (next.clientX - start.clientX))))
  })
  const useConnection = async (item: Connection, schemaName?: string, extra?: Pick<PendingSchemaPick, 'folder' | 'open'>) => {
    const selected = item.id === connection.id
    if (schemaName || extra) pendingRef.current = { connectionId: item.id, schema: schemaName || '', ...extra }
    if (!selected && await onPick(item.id) === false) {pendingRef.current=undefined;return}
    if (!selected) return
    else if (schemaName) actionsRef.current?.activateSchema(schemaName)
  }
  return <section ref={shellRef} className={`db-shell${narrow ? ' is-connection-compact' : ''}${drawerOpen ? ' is-connection-open' : ''}`} aria-label="数据库工作台">
    <WorkbenchTooltips/>
    <div className="db-shell-body">
      {narrow && drawerOpen && <DrawerBackdrop className="db-connection-backdrop" label="关闭连接导航" close={closeDrawer}/>}
      <aside ref={sideRef} tabIndex={-1} className={`db-object-sidebar ${collapsed && !narrow ? 'is-collapsed' : ''}`} style={collapsed && !narrow ? { width: PANE_GUTTER } : { width: narrow ? 280 : Math.min(sideWidth, Math.max(180, shellWidth - 760)) }} aria-label="我的连接" aria-hidden={narrow && !drawerOpen ? true : undefined}>
        {(!collapsed || narrow) && <div className="db-sidebar-toolbar">
          {narrow && <DrawerClose className="db-connection-drawer-close" label="关闭连接导航" close={closeDrawer}/>}
          <div className="db-catalog-search"><Search size={15} /><input aria-label="搜索连接或对象" placeholder="搜索" value={search} onChange={e => setSearch(e.target.value)} />{search && <button className="db-icon-button" aria-label="清空搜索" onClick={() => setSearch('')}><X size={12} /></button>}</div>
        </div>}
        {(!collapsed || narrow) && <div className="db-object-tree db-conn-tree" onMouseDown={event => { if (event.detail > 1) event.preventDefault() }}>
          <strong>
            <FolderTree size={14} className="db-tree-icon" />我的连接
            <button type="button" className="db-icon-button" aria-label="新建连接" onClick={onAdd}><Plus size={14} /></button>
          </strong>
          {visibleConnections.map(item => {
            const connecting = item.lifecycle?.status === 'queued' || item.lifecycle?.status === 'running'
            const selected = item.id === connection.id
            const SourceTree = clientModules.get(item.dialect).tree?.render
            return <ConnectionTreeBranch
              key={item.id}
              item={item}
              sourceTree={SourceTree && expandedIds.includes(item.id) && item.live ? <SourceTree bridge={host} connection={item} selectedId={selected ? catalogRoots[item.id] || '' : undefined} refreshToken={sourceRefresh[item.id] || 0} onSelect={async id => {if(!selected && await onPick(item.id)===false)return;setCatalogRoot(id,item.id)}} /> : clientWorkspaceDescriptor(item.dialect).showsSchemaTree && expandedIds.includes(item.id) && item.live ? <SqlConnectionTree item={item} cache={cache} selected={selected} schema={selected?schema:""} search={search} treeFocus={selected?treeFocus:undefined} onPick={()=>{void onPick(item.id)}}
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
 /> : undefined}
              selected={selected}
              connecting={connecting}
              actionBlocked={busyConnections?.has(item.id) ? '此连接正在处理请求。' : undefined}
              treeBusy={!!item.live && (cache.schemasStatus(item)?.status === 'loading' || selected && treeBusy)}
              search={search}
              expanded={expandedIds.includes(item.id)}
              overflow={connectionMenu?.id === item.id ? connectionMenu : undefined}
              onPick={() => { pendingRef.current = undefined; onPick(item.id) }}
              onConnect={() => onConnect?.(item.id)}
              onCancelConnect={() => onCancelConnect?.(item.id)}
              onEdit={() => onEdit(item.id)}
              onCopy={() => onCopy?.(item.id)}
              onDisconnect={() => onDisconnect?.(item.id)}
              onDelete={() => onDelete?.(item.id)}
              onToggleExpanded={() => setExpandedIds(ids => ids.includes(item.id) ? ids.filter(id => id !== item.id) : [...ids, item.id])}
              onRefresh={() => {
                if(clientWorkspaceDescriptor(item.dialect).showsSchemaTree)void refreshCatalogLayer(cache,item,{layer:"connection"}).catch(()=>{})
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
              onActivateRoot={async id => {
                if (!selected && await onPick(item.id)===false)return
                pendingRef.current = undefined
                setCatalogRoot(id,item.id)
              }}
              onOpenOverflow={next => setConnectionMenu({id:item.id,...next})}
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
        {narrow && <button ref={triggerRef} type="button" className="db-icon-button db-connection-trigger" aria-label="打开连接导航" title="连接" aria-expanded={drawerOpen} onClick={()=>setDrawerOpen(value=>!value)}><FolderTree size={16}/></button>}
        <React.Fragment key={`${conversationId}:${connection.id}`}>
        {workspaceSources.get(connection.dialect).render({
          conversationId, host, connection, connections, sql, refreshToken: sourceRefresh[connection.id] || 0, catalogRoot, onCatalogRoot:root=>setCatalogRoot(root), onPick, onWorkbench,
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

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { ObjectWorkspace } from './object-workspace.tsx'
import { SqlWorkspaceTab } from './sql-workspace-tab.tsx'
import { AiActivityBanner, AiExecutions } from './ai-executions.tsx'
import { SqlTemplateLibrary } from './sql-template-library.tsx'
import { ObjectHome } from './object-home.tsx'
import { StructureForm } from './structure-form.tsx'
import { useAiQueryBus } from './ai-query-bus.ts'
import { consumePendingSchema, type ObjectKind } from './tree-pane-actions.ts'
import type { TreeFocus } from './tree-focus.ts'
import { refreshCatalogLayer } from './schema/refresh.ts'
import { catalogSchemaName, coerceVisibleSchemas, composeTableSelect, emptySharedQuery, pickDefaultSchema, type CatalogResult, type ConnectionWorkbench, type SharedQuery } from '../shared/workbench.ts'
import { dialectCapabilities } from '../shared/dialect-capabilities.ts'
import { useDelayedClickDismiss } from './workspace/parts/use-delayed-click-dismiss.ts'
import { isAbortError } from '../shared/connection-errors.ts'
import { WorkspaceTabs, useWorkspaceTabState } from './workspace/source/workspace-tabs.tsx'
import type { WorkspaceSourceContext } from './workspace-sources.tsx'

type Tab =
  | { id: string; kind: 'home' }
  | { id: string; kind: 'object'; schema: string; name: string; objectKind: ObjectKind; sub: 'data' | 'columns' | 'indexes' }
  | { id: string; kind: 'sql'; name: string; sql: string; savedExperience?: boolean }
  | { id: string; kind: 'ai' }
  | { id: string; kind: 'templates' }

export function ActiveConnectionPane({
  conversationId, host, connection, connections, cache, pendingRef, sqlCacheRef, actionsRef, onPick, onWorkbench, onSchema, onTreeBusy, onTreeFocus,
}: WorkspaceSourceContext): React.ReactElement {
  const taken = consumePendingSchema(pendingRef, connection.id)
  const initialSchema = taken.schema || connection.workbench?.schema || ''
  const [schemas, setSchemas] = useState<Record<string, unknown>[]>(() => cache.schemasSnapshot(connection) || [])
  const [schema, setSchema] = useState(initialSchema)
  const [objects, setObjects] = useState<Record<string, unknown>[]>(() => {
    const cached = initialSchema ? cache.tablesSnapshot(connection, initialSchema) : undefined
    return cached ? cached.map(item => item.record) : []
  })
  const [treeBusy, setTreeBusy] = useState(false)
  const [treeFocus, setTreeFocus] = useState<TreeFocus | undefined>(initialSchema ? { kind: 'schema', schema: initialSchema } : undefined)
  const [folder, setFolder] = useState<ObjectKind>(taken.folder || 'table')
  const [hint, setHint] = useState('')
  const pendingOpen = taken.open && initialSchema ? { schema: initialSchema, table: taken.open.table, kind: taken.open.kind } : undefined
  const { tabs, setTabs, active, setActive, open: openTab, close: closeTab } = useWorkspaceTabState<Tab>(() => {
    const sql = (connection.workbench?.queryTabs || []).map(tab => ({ id: tab.id, kind: 'sql' as const, name: tab.name, sql: tab.sql }))
    const rows: Tab[] = [{ id: 'home', kind: 'home' }, ...sql]
    if (pendingOpen) rows.push({ id: `object:${pendingOpen.schema}:${pendingOpen.kind}:${pendingOpen.table}`, kind: 'object', schema: pendingOpen.schema, name: pendingOpen.table, objectKind: pendingOpen.kind, sub: 'data' })
    return rows
  }, () => {
    if (pendingOpen) return `object:${pendingOpen.schema}:${pendingOpen.kind}:${pendingOpen.table}`
    const restored = connection.workbench?.activeTabId
    const sql = connection.workbench?.queryTabs || []
    if (restored && sql.some(tab => tab.id === restored)) return restored
    return 'home'
  }, { id: tab => tab.id, fallback: 'home', onClose: closing => {
    if (closing.kind !== 'sql') return
    const cached = sqlCacheRef.current.get(`${conversationId}:${connection.id}`) || []
    sqlCacheRef.current.set(`${conversationId}:${connection.id}`, [...cached.filter(item => item.id !== closing.id), { id: closing.id, name: closing.name, sql: closing.sql }])
  } })
  const [menu, setMenu] = useState<{ x: number; y: number; schema: string; name: string; objectKind: ObjectKind }>()
  const [sqlSeq, setSqlSeq] = useState((connection.workbench?.queryTabs?.length || 0) + 1)
  const [status, setStatus] = useState<{ rows?: number; elapsedMs?: number; failed?: boolean; message?: string }>({})
  const [collabQuery, setCollabQuery] = useState<SharedQuery>(connection.workbench?.sharedQuery || emptySharedQuery())
  const [focusTemplateId, setFocusTemplateId] = useState<string>()
  const [structureDraft, setStructureDraft] = useState<{ table?: string; metadata?: CatalogResult; executionId?: string }>()
  const [schemaFilter, setSchemaFilter] = useState<string[]>(() => coerceVisibleSchemas(connection.workbench?.visibleSchemas))
  const [templateEpoch, setTemplateEpoch] = useState(0)
  const [highlight, setHighlight] = useState('')
  const [cacheTick, setCacheTick] = useState(0)
  const schemaSeen = useRef(schema)
  const collabSchemaSeen = useRef(connection.workbench?.sharedQuery?.schema)
  const treeSeq = useRef(0)
  const persistPatch = useRef<ConnectionWorkbench>()
  const onWorkbenchRef = useRef(onWorkbench)
  onWorkbenchRef.current = onWorkbench
  const queryBus = useAiQueryBus({ bridge: host, connection, query: collabQuery, onQuery: setCollabQuery })
  useEffect(() => cache.subscribe(() => setCacheTick(n => n + 1)), [cache])

  const sqlCacheKey = `${conversationId}:${connection.id}`
  const sqlTabsFor = (open: Tab[]) => {
    const seen = new Set<string>()
    const rows: { id: string; name: string; sql: string }[] = []
    for (const tab of [...open.filter((item): item is Tab & { kind: 'sql' } => item.kind === 'sql'), ...sqlCacheRef.current.get(sqlCacheKey) || []]) {
      if (seen.has(tab.id)) continue
      seen.add(tab.id)
      rows.push({ id: tab.id, name: tab.name, sql: tab.sql })
    }
    return rows
  }
  const workbenchPatch = (): ConnectionWorkbench => ({
    schema,
    queryTabs: sqlTabsFor(tabs),
    activeTabId: tabs.some(tab => tab.id === active && tab.kind === 'sql') ? active : undefined,
  })
  persistPatch.current = workbenchPatch()

  useLayoutEffect(() => { onSchema(schema) }, [schema, onSchema])
  useLayoutEffect(() => { onTreeBusy(treeBusy) }, [treeBusy, onTreeBusy])
  useLayoutEffect(() => { onTreeFocus(treeFocus) }, [treeFocus, onTreeFocus])

  useEffect(() => {
    const save = onWorkbenchRef.current
    const id = connection.id
    const timer = setTimeout(() => save?.(id, persistPatch.current || workbenchPatch()), 400)
    return () => clearTimeout(timer)
  }, [schema, tabs, active, connection.id])
  useEffect(() => {
    setSchemaFilter(coerceVisibleSchemas(connection.workbench?.visibleSchemas))
  }, [connection.id, connection.workbench?.visibleSchemas])
  useEffect(() => {
    const id = connection.id
    const save = onWorkbenchRef.current
    return () => {
      const patch = persistPatch.current
      if (patch) save?.(id, patch)
    }
  }, [connection.id])
  useEffect(() => {
    if (schemaSeen.current && schemaSeen.current !== schema) {
      setTreeFocus(current => (current && 'schema' in current && current.schema === schema)
        ? current
        : (schema ? { kind: 'schema', schema } : undefined))
    }
    schemaSeen.current = schema
  }, [schema])
  const restoreSchema = (name: string) => {
    if (!name) return
    setSchema(name)
    setTreeFocus({ kind: 'schema', schema: name })
  }
  useEffect(() => {
    if (active !== 'ai') return
    const qs = collabQuery.schema?.trim()
    if (!qs || qs === collabSchemaSeen.current) return
    collabSchemaSeen.current = qs
    if (qs !== schema) restoreSchema(qs)
  }, [active, collabQuery.schema, schema])
  useDelayedClickDismiss(!!menu, () => setMenu(undefined))

  const loadTree = async (nextSchema: string, refresh = false, signal?: AbortSignal) => {
    const seq = ++treeSeq.current
    const targetSchema = nextSchema || schema
    const storedSchemas = !refresh ? cache.schemasSnapshot(connection) : undefined
    if (!refresh && targetSchema && connection.live) {
      const cachedTables = cache.tablesSnapshot(connection, targetSchema)
      if (cachedTables !== undefined && storedSchemas?.length) {
        setSchemas(storedSchemas)
        setObjects(cachedTables.map(item => item.record))
        return
      }
    }
    if (!storedSchemas?.length) setTreeBusy(true)
    try {
      const items = storedSchemas?.length ? storedSchemas : await cache.loadSchemas(connection, { refresh, signal })
      if (seq !== treeSeq.current) return
      setSchemas(items)
      const picked = pickDefaultSchema({
        dialect: connection.dialect,
        schemas: items,
        savedSchema: nextSchema,
        database: connection.database,
        username: connection.settings?.username,
      })
      if (picked && picked !== schema && seq === treeSeq.current) setSchema(picked)
      if (!picked) return
      const names = items.map(row => catalogSchemaName(row)).filter(Boolean)
      if (!names.includes(picked) && !(dialectCapabilities(connection.dialect).namespaceCaseInsensitive && names.some(name => name.toLowerCase() === picked.toLowerCase()))) return
      const tables = await cache.loadTables(connection, picked, { refresh, signal, quiet: !refresh && !!storedSchemas?.length })
      if (seq !== treeSeq.current) return
      setObjects(tables.map(item => item.record))
    } catch (error) {
      if (isAbortError(error, signal) || seq !== treeSeq.current) return
      setHint(error instanceof Error ? error.message : '无法读取对象')
    } finally {
      if (seq === treeSeq.current) setTreeBusy(false)
    }
  }
  useEffect(() => {
    if (!connection.live) return
    const controller = new AbortController()
    void loadTree(schema, false, controller.signal)
    return () => controller.abort()
  }, [cache, connection.id, connection.generation, connection.live, schema])
  useEffect(() => {
    if (connection.health === 'offline' && !connection.live) return
    const listed = cache.schemasSnapshot(connection)
    if (listed) setSchemas(listed)
    if (!schema) return
    const cached = cache.tablesSnapshot(connection, schema)
    if (cached) setObjects(cached.map(item => item.record))
  }, [cache, cacheTick, connection.id, connection.generation, connection.live, connection.health, schema])

  const allSchemaNames = schemas.map(row => catalogSchemaName(row)).filter(Boolean)
  const sqlSchemaNames = schemaFilter.length
    ? [...schemaFilter].sort((a, b) => a.localeCompare(b))
    : allSchemaNames
  const showHome = (next: ObjectKind) => {
    setFolder(next)
    setActive('home')
  }
  const showHomeFolder = (next: ObjectKind) => {
    showHome(next)
    if (schema) setTreeFocus({ kind: 'folder', schema, folder: next })
  }
  const syncListHighlight = (name: string, kind: ObjectKind) => {
    setHighlight(name)
    setFolder(kind)
  }
  const pickHighlight = (name: string, kind: ObjectKind) => {
    syncListHighlight(name, kind)
    if (schema) setTreeFocus({ kind: 'table', schema, table: name, objectKind: kind })
  }
  const openObject = (schemaName: string, name: string, objectKind: ObjectKind, sub: 'data' | 'columns' | 'indexes' = 'data') => {
    const id = `object:${schemaName}:${objectKind}:${name}`
    setTabs(old => old.some(tab => tab.id === id)
      ? old.map(tab => tab.id === id && tab.kind === 'object' ? { ...tab, sub } : tab)
      : [...old, { id, kind: 'object', schema: schemaName, name, objectKind, sub }])
    setActive(id); setHighlight(name); setMenu(undefined)
  }
  const objectTabLabel = (tab: Tab & { kind: 'object' }) => `${tab.schema}.${tab.name}`
  const openSql = (sql = '') => {
    const cached = sqlCacheRef.current.get(sqlCacheKey) || []
    if (!sql && cached.length) {
      const restored = cached[cached.length - 1]
      sqlCacheRef.current.set(sqlCacheKey, cached.slice(0, -1))
      setTabs(old => old.some(tab => tab.id === restored.id) ? old : [...old, { ...restored, kind: 'sql' as const }])
      setActive(restored.id)
      return
    }
    const name = `SQL-${sqlSeq}`
    const id = `sql:${crypto.randomUUID()}`
    setSqlSeq(n => n + 1)
    setTabs(old => [...old, { id, kind: 'sql', name, sql }])
    setActive(id)
  }
  const openNamed = (tab: Tab) => {
    openTab(tab)
  }
  const openTemplatesTab = (templateId?: string) => {
    if (templateId) setFocusTemplateId(templateId)
    openNamed({ id: 'templates', kind: 'templates' })
  }
  const copyName = async (name: string) => { try { await navigator.clipboard.writeText(name) } catch { /* ignore */ } }
  const activateSchema = (name: string) => {
    setSchema(name)
    const cached = cache.tablesSnapshot(connection, name)
    if (cached) setObjects(cached.map(row => row.record))
  }

  actionsRef.current = {
    activateSchema,
    showHomeFolder,
    focusTree: next => setTreeFocus(next),
    highlight: syncListHighlight,
    openObject,
    openContextMenu: (event, schemaName, tableName, kind) => {
      activateSchema(schemaName)
      setMenu({ x: event.clientX, y: event.clientY, schema: schemaName, name: tableName, objectKind: kind })
    },
    refresh: () => { void refreshCatalogLayer(cache, connection, schema ? { layer: 'database', schema } : { layer: 'connection' }).catch(() => {}) },
    openSql,
    openNamed: kind => openNamed({ id: kind, kind }),
  }

  const env = connection.environment.toUpperCase()
  const workspaceTabs = tabs
  const activeTab = tabs.find(tab => tab.id === active)
  return <>
    <header className="db-shell-top">
      <button className="db-primary" disabled={!connection.live || !schema} aria-label="新建查询" onClick={() => openSql()}><Plus size={14} />新建查询</button>
      <button aria-pressed={folder === 'table' && active === 'home'} onClick={() => showHomeFolder('table')}>表</button>
      <button aria-pressed={folder === 'view' && active === 'home'} onClick={() => showHomeFolder('view')}>视图</button>
      <button onClick={() => openNamed({ id: 'ai', kind: 'ai' })}>AI Query</button>
      <button onClick={() => openNamed({ id: 'templates', kind: 'templates' })}>经验库</button>
      <span className="db-session"><span className={`db-status-dot ${connection.live ? '' : 'is-off'}`} />{connection.health === 'degraded' ? '部分可用' : connection.health === 'connecting' ? '连接中' : connection.live ? '已连接' : '未连接'}</span>
    </header>
    <div className="db-shell-main">
      <WorkspaceTabs tabs={workspaceTabs.map(tab => ({ id: tab.id, label: tab.kind === 'home' ? (folder === 'view' ? '视图' : '表') : tab.kind === 'object' ? objectTabLabel(tab) : tab.kind === 'sql' ? tab.name : tab.kind === 'ai' ? 'AI Query' : '经验库', closable: tab.kind !== 'home' }))} active={active} onActivate={setActive} onClose={closeTab} />
      {hint && <p className="db-info-note" role="status">{hint}</p>}
      <AiActivityBanner items={queryBus.items} peer={queryBus.peer} onOpen={() => { openNamed({ id: 'ai', kind: 'ai' }); }} onViewPeer={id => {
        if (!connections.find(item => item.id === id)?.live) return
        onPick(id)
        openNamed({ id: 'ai', kind: 'ai' })
      }} onDismissPeer={() => queryBus.dismissPeer()} />
      {tabs.map(tab => <div key={tab.id} hidden={active !== tab.id} className="db-tab-body">
        {tab.kind === 'home' && <ObjectHome schema={schema} folder={folder} objects={objects} busy={treeBusy} highlight={highlight} connection={connection} cache={cache} treeFocus={treeFocus} onHighlight={pickHighlight} onOpen={(name, kind) => openObject(schema, name, kind)} onHint={setHint} />}
        {tab.kind === 'object' && (connection.live
          ? <ObjectWorkspace bridge={host} connection={connection} schema={tab.schema} table={tab.name} isView={tab.objectKind === 'view'} sub={tab.sub} cache={cache} active={active === tab.id} onSub={sub => setTabs(old => old.map(item => item.id === tab.id && item.kind === 'object' ? { ...item, sub } : item))} onStatus={setStatus} />
          : <p className="db-info-note">请先连接数据库后再打开表。</p>)}
        {tab.kind === 'sql' && (connection.live
          ? <SqlWorkspaceTab key={tab.id} bridge={host} connection={connection} schema={schema} schemas={sqlSchemaNames} cache={cache} initialSql={tab.sql} tabId={tab.id} tabName={tab.name} savedExperience={tab.savedExperience} templateReloadKey={templateEpoch} active={active === tab.id} onStatus={setStatus} onSql={sql => setTabs(old => old.map(item => item.id === tab.id && item.kind === 'sql' ? { ...item, sql, savedExperience: item.sql === sql ? item.savedExperience : false } : item))} onSavedExperience={() => { setTemplateEpoch(n => n + 1); setTabs(old => old.map(item => item.id === tab.id && item.kind === 'sql' ? { ...item, savedExperience: true } : item)) }} onSavedToLibrary={id => { openTemplatesTab(id); closeTab(tab.id) }} onSchemaChange={setSchema} />
          : <p className="db-info-note">请先连接数据库后再编写或执行 SQL。</p>)}
        {tab.kind === 'ai' && <AiExecutions hidden={active !== tab.id} bridge={host} connection={connection} schema={schema} schemas={sqlSchemaNames} cache={cache} query={collabQuery} onQuery={setCollabQuery} templateReloadKey={templateEpoch} onOpenTemplates={openTemplatesTab} onRestoreSchema={restoreSchema} items={queryBus.items} display={queryBus.display} onDisplay={queryBus.setDisplay} markEditing={queryBus.markEditing} error={queryBus.error} onWriteSql={(sql, schemaName) => {
          const nextSchema = schemaName?.trim() || schema
          if (nextSchema) restoreSchema(nextSchema)
          void host.executions?.('shared-query-update', { id: connection.id, patch: { sql, schema: nextSchema }, source: 'user', revision: collabQuery.revision }).then(body => {
            const next = (body as { sharedQuery?: SharedQuery }).sharedQuery
            if (next) setCollabQuery(next)
          })
        }} onOpenDraft={(draft, executionId) => {
          if (!connection.live) return
          const draftSchema = draft.schema?.trim() || schema
          if (draftSchema) restoreSchema(draftSchema)
          if (draft.kind === 'query' && draft.sql?.trim()) {
            void host.executions?.('shared-query-update', { id: connection.id, patch: { sql: draft.sql, schema: draftSchema }, source: 'user', revision: collabQuery.revision }).then(body => {
              const next = (body as { sharedQuery?: SharedQuery }).sharedQuery
              if (next) setCollabQuery(next)
            })
            return
          }
          if (draft.kind === 'ddl') setStructureDraft({ table: draft.table, executionId })
        }} />}
        {tab.kind === 'templates' && <SqlTemplateLibrary embedded bridge={host} connection={connection} schema={schema} schemas={sqlSchemaNames} cache={cache} focusTemplateId={focusTemplateId} reloadKey={templateEpoch} onClose={() => closeTab('templates')} onApply={sql => openSql(sql)} onSaved={id => { setTemplateEpoch(n => n + 1); setFocusTemplateId(id) }} onSchemaChange={setSchema} />}
      </div>)}
    </div>
    <footer className="db-shell-status">{env} | {schema || '—'} | {connection.live ? '已连接' : '未连接'}{activeTab?.kind === 'object' ? ` | ${objectTabLabel(activeTab)}` : activeTab?.kind === 'sql' ? ` | ${activeTab.name}` : activeTab?.kind === 'home' ? ` | ${folder === 'view' ? '视图' : '表'}` : ''}{status.message ? ` | ${status.message}` : status.failed ? ' | 失败' : status.rows !== undefined ? ` | ${status.rows} 行` : ''}{status.message ? '' : status.elapsedMs !== undefined ? ` | ${status.elapsedMs}ms` : ''}</footer>
    {menu && <div className="db-dropdown db-context-menu" style={{ position: 'fixed', left: menu.x, top: menu.y }} role="menu" onClick={event => event.stopPropagation()}>
      <button onClick={() => openObject(menu.schema, menu.name, menu.objectKind, 'data')}>打开数据</button>
      <button onClick={() => openObject(menu.schema, menu.name, menu.objectKind, 'columns')}>查看字段</button>
      {menu.objectKind === 'table' && <button onClick={() => openObject(menu.schema, menu.name, menu.objectKind, 'indexes')}>查看索引</button>}
      <button onClick={() => { openSql(`${composeTableSelect(connection.dialect, menu.schema, menu.name)};`); setMenu(undefined) }}>SQL查询</button>
      <button onClick={() => { void copyName(menu.name); setMenu(undefined) }}>复制表名</button>
      <button onClick={() => { void refreshCatalogLayer(cache, connection, menu ? { layer: 'table', schema: menu.schema, table: menu.name } : { layer: 'connection' }).catch(() => {}); setMenu(undefined) }}>刷新</button>
    </div>}
    {structureDraft && <StructureForm bridge={host} connection={connection} schema={schema} table={structureDraft.table} metadata={structureDraft.metadata} executionId={structureDraft.executionId} onClose={() => setStructureDraft(undefined)} onChanged={() => setStructureDraft(undefined)} />}
  </>
}

import type { Connection } from '../../shared/workbench.ts'
import type { SchemaCache } from './schema-cache.ts'

export type RefreshLayer = 'connection' | 'database' | 'table'

export type RefreshTarget = {
  layer: RefreshLayer
  schema?: string
  table?: string
}

/** Layered metadata refresh: never reconnects the Profile, never invalidates sibling layers. */
export async function refreshCatalogLayer(cache: SchemaCache, connection: Connection, target: RefreshTarget, signal?: AbortSignal): Promise<void> {
  if (target.layer === 'connection') {
    await cache.loadSchemas(connection, { refresh: true, signal })
    return
  }
  if (target.layer === 'database' && target.schema) {
    await cache.loadTables(connection, target.schema, { refresh: true, signal })
    return
  }
  if (target.layer === 'table' && target.schema && target.table) {
    await cache.loadTable(connection, target.schema, target.table, { refresh: true, signal })
  }
}

export function sameWorkspaceConnection(a: Connection, b: Connection): boolean {
  return a.id === b.id
    && a.generation === b.generation
    && a.live === b.live
    && a.health === b.health
    && a.version === b.version
    && a.database === b.database
    && a.name === b.name
    && a.environment === b.environment
    && (a.databases || []).join('\0') === (b.databases || []).join('\0')
    && JSON.stringify(a.workbench || {}) === JSON.stringify(b.workbench || {})
}

export function mergeWorkspaceConnections(previous: Connection[], listed: Connection[]): Connection[] {
  return mergeListed(previous, listed, blendLiveConnection)
}

/** 切对话时换成该对话的 SQL/AI，保留连接身份和可见库。 */
export function mergeSessionConnections(previous: Connection[], listed: Connection[]): Connection[] {
  return mergeListed(previous, listed, takeSessionWorkbench)
}

function mergeListed(previous: Connection[], listed: Connection[], blend: (previous: Connection, next: Connection) => Connection): Connection[] {
  const next = new Map(listed.map(row => [row.id, row]))
  const merged: Connection[] = []
  const seen = new Set<string>()
  for (const row of previous) {
    const fresh = next.get(row.id)
    if (!fresh) continue
    seen.add(row.id)
    next.delete(row.id)
    if (sameWorkspaceConnection(row, fresh)) merged.push(row)
    else merged.push(blend(row, fresh))
  }
  for (const row of next.values()) if (!seen.has(row.id)) merged.push(row)
  return merged
}

const sessionWorkbenchKeys = ['schema', 'view', 'queryTabs', 'activeTabId', 'sharedQuery', 'history', 'templates'] as const

function takeSessionWorkbench(previous: Connection, next: Connection): Connection {
  const blended = blendLiveConnection(previous, next)
  const workbench = { ...blended.workbench }
  const source = next.workbench
  if (source?.schema === undefined) delete workbench.schema
  else workbench.schema = source.schema
  if (source?.view === undefined) delete workbench.view
  else workbench.view = source.view
  if (source?.queryTabs === undefined) delete workbench.queryTabs
  else workbench.queryTabs = source.queryTabs
  if (source?.activeTabId === undefined) delete workbench.activeTabId
  else workbench.activeTabId = source.activeTabId
  if (source?.sharedQuery === undefined) delete workbench.sharedQuery
  else workbench.sharedQuery = source.sharedQuery
  if (source?.history === undefined) delete workbench.history
  else workbench.history = source.history
  if (source?.templates === undefined) delete workbench.templates
  else workbench.templates = source.templates
  const connection = { ...blended }
  if (Object.keys(workbench).length) connection.workbench = workbench
  else delete connection.workbench
  return connection
}

/** 登录/轮询回来的连接不要盖掉本地连接树下一级可见项。空数组表示显示全部，不能用 ?? 回退到服务端旧值。 */
export function blendLiveConnection(previous: Connection, next: Connection): Connection {
  const workbench = { ...previous.workbench, ...next.workbench }
  if (previous.workbench && Object.hasOwn(previous.workbench, 'visibleSchemas')) workbench.visibleSchemas = previous.workbench.visibleSchemas
  else if (!workbench.visibleSchemas?.length) delete workbench.visibleSchemas
  return { ...previous, ...next, workbench }
}

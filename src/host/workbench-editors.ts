import type { DatabaseWorkspaceSnapshot } from '../shared/workbench.ts'

export type WorkbenchEditorView = {
  connectionId: string
  name: string
  live: boolean
  schema?: string
  current: boolean
  activeQuery?: { name: string; sql: string }
  queries: { name: string; sql: string; active: boolean }[]
  aiQuery?: { sql: string; controller: string; revision: number }
  lastRun?: unknown
}

export function workbenchEditorViews(snap: DatabaseWorkspaceSnapshot): WorkbenchEditorView[] {
  return snap.connections.map(item => {
    const tabs = item.workbench?.queryTabs || []
    const activeId = item.workbench?.activeTabId
    const active = tabs.find(tab => tab.id === activeId) || tabs[0]
    const aiSql = item.workbench?.sharedQuery?.sql || ''
    return {
      connectionId: item.id,
      name: item.name,
      live: !!item.live,
      schema: item.workbench?.sharedQuery?.schema || item.workbench?.schema || item.database,
      current: item.id === snap.lastActiveId,
      activeQuery: active?.sql ? { name: active.name, sql: active.sql } : undefined,
      queries: tabs.filter(tab => tab.sql).map(tab => ({ name: tab.name, sql: tab.sql, active: tab.id === active?.id })),
      aiQuery: aiSql ? { sql: aiSql, controller: item.workbench?.sharedQuery?.controller || 'ai', revision: item.workbench?.sharedQuery?.revision || 1 } : undefined,
      lastRun: item.workbench?.sharedQuery?.lastRun,
    }
  }).filter(item => item.activeQuery || item.aiQuery || item.lastRun)
}

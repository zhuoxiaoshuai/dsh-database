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
    // 内部真相是执行文档；与公共投影一致，只有 SQL 文档进入编辑器视图的 aiQuery。
    const document = item.workbench?.aiDocument
    const sql = document && (document.sourceId === 'mysql' || document.sourceId === 'oracle') ? document : undefined
    return {
      connectionId: item.id,
      name: item.name,
      live: !!item.live,
      schema: sql?.context.schema || item.workbench?.schema || item.database,
      current: item.id === snap.lastActiveId,
      activeQuery: active?.sql ? { name: active.name, sql: active.sql } : undefined,
      queries: tabs.filter(tab => tab.sql).map(tab => ({ name: tab.name, sql: tab.sql, active: tab.id === active?.id })),
      aiQuery: sql?.text ? { sql: sql.text, controller: sql.controller || 'ai', revision: sql.revision || 1 } : undefined,
      // 刻画结论：公共投影不含 lastRun，迁移后的文档恒取不到 lastRun；保持取不到，不新造来源。
      lastRun: undefined,
    }
  }).filter(item => item.activeQuery || item.aiQuery || item.lastRun)
}

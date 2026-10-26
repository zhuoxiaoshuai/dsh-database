import type { DatabaseWorkspaceSnapshot } from '../shared/workbench.ts'
import { projectedLastRun } from './saved-connections.ts'

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
      // 已修复：lastRun 现在来自执行记录。快照公共投影按 getSharedQuery 同一套匹配规则现算补入，
      // 无执行记录时字段不存在，这里保持 undefined；非 SQL 文档没有该投影，也不提供 lastRun。
      lastRun: sql ? projectedLastRun(item.workbench) : undefined,
    }
  }).filter(item => item.activeQuery || item.aiQuery || item.lastRun)
}

import React from 'react'
import { format } from 'sql-formatter'
import { SqlEditor } from './editor.tsx'
import type { SchemaCache } from './schema/schema-cache.ts'
import { ExecutionWorkbench } from './workspace/source/execution-workbench.tsx'
import type { Connection } from '../shared/workbench.ts'
import { dialectCapabilities } from '../shared/dialect-capabilities.ts'
import { AiControlBar } from './workspace/source/ai-control-bar.tsx'

export type SqlQueryActions = {
  run: boolean
  runAll: boolean
  cancel: boolean
  format: boolean
  clear: boolean
  save: boolean
  explain: boolean
  applyToQuery: boolean
  ai: boolean
}

const defaultActions: SqlQueryActions = {
  run: true,
  runAll: false,
  cancel: true,
  format: true,
  clear: true,
  save: true,
  explain: true,
  applyToQuery: false,
  ai: false,
}

export type SqlRunWorkspaceAiProps = {
  controller: 'ai' | 'user'
  connectionName: string
  target: string
  onTakeover(): void
  onReturnAi(): void
}

/** Navicat 式：结果占满；编辑器/工具条可收成细条。 */
export function SqlRunWorkspace({
  className = 'db-sql-run-workspace',
  connection,
  schema,
  cache,
  sql,
  onChange,
  onSelectionChange,
  onCursorChange,
  onRun,
  onRunAll,
  onExplain,
  busy = false,
  runProgress,
  hasSelection = false,
  onCancel,
  onFormat,
  onClear,
  onSave,
  onApply,
  canRun,
  canSave,
  canExplain,
  actions: actionsPatch,
  toolbarStart,
  toolbarExtra,
  toolbarEnd,
  ai,
  editorExtra,
  resultFrame,
  resultOpen: controlledOpen,
  onResultOpenChange,
  editorOpen: controlledEditorOpen,
  onEditorOpenChange,
  editorRatio: controlledRatio,
  onRatioChange,
}: {
  className?: string
  connection: Connection
  schema: string
  cache?: SchemaCache
  sql: string
  onChange(sql: string): void
  onSelectionChange?(text: string): void
  onCursorChange?(offset: number): void
  onRun?(selection?: string, mode?: 'current' | 'all'): void
  onRunAll?(): void
  onExplain?(selection?: string): void
  busy?: boolean
  runProgress?: string
  hasSelection?: boolean
  onCancel?(): void
  onFormat?(): void
  onClear?(): void
  onSave?(): void
  onApply?(): void
  canRun?: boolean
  canSave?: boolean
  canExplain?: boolean
  actions?: Partial<SqlQueryActions>
  toolbarStart?: React.ReactNode
  toolbarExtra?: React.ReactNode
  toolbarEnd?: React.ReactNode
  ai?: SqlRunWorkspaceAiProps
  editorExtra?: React.ReactNode
  resultFrame: React.ReactElement
  resultOpen?: boolean
  onResultOpenChange?(open: boolean): void
  editorOpen?: boolean
  onEditorOpenChange?(open: boolean): void
  editorRatio?: number
  onRatioChange?(ratio: number): void
}): React.ReactElement {
  const actions = { ...defaultActions, ...actionsPatch }
  const runDisabled = busy || !connection.live || (canRun === false) || !sql.trim()
  const saveDisabled = busy || (canSave === false) || !sql.trim()
  const explainDisabled = busy || !connection.live || (canExplain === false) || !sql.trim()

  const handleFormat = () => {
    if (onFormat) { onFormat(); return }
    try {
      onChange(format(sql, { language: dialectCapabilities(connection.dialect).formatterLanguage }))
    } catch { /* keep */ }
  }
  const handleClear = () => {
    if (onClear) { onClear(); return }
    onChange('')
  }
  const run = () => onRun?.(undefined, hasSelection ? 'current' : 'all')
  const railRun = <>
    {actions.run && <button type="button" className="db-text-button" disabled={runDisabled} onClick={run}>{hasSelection ? '执行选中' : '运行'}</button>}
    {actions.cancel && onCancel && busy && <button type="button" className="db-text-button" onClick={onCancel}>停止</button>}
    {runProgress && <span className="db-muted" role="status">{runProgress}</span>}
  </>
  const toolbar = <div className="db-catalog-tools db-sql-toolbar">
    {toolbarStart}
    {actions.run && <button type="button" className="db-sql-toolbar-btn db-primary" disabled={runDisabled} onClick={run}>{hasSelection ? '执行选中' : '运行'}</button>}
    {actions.runAll && <button type="button" className="db-sql-toolbar-btn" disabled={runDisabled} onClick={() => onRunAll?.()}>运行全部</button>}
    {actions.cancel && onCancel && <button type="button" className="db-sql-toolbar-btn" disabled={!busy} onClick={onCancel}>停止</button>}
    {runProgress && <span className="db-muted db-sql-run-progress" role="status">{runProgress}</span>}
    {actions.explain && onExplain && <button type="button" className="db-sql-toolbar-btn" disabled={explainDisabled} onClick={() => onExplain()}>解释</button>}
    {actions.save && onSave && <button type="button" className="db-sql-toolbar-btn" disabled={saveDisabled} onClick={onSave}>保存</button>}
    {actions.format && <button type="button" className="db-sql-toolbar-btn" disabled={busy} onClick={handleFormat}>格式化</button>}
    {actions.clear && <button type="button" className="db-sql-toolbar-btn" disabled={busy || !sql} onClick={handleClear}>清空</button>}
    {actions.applyToQuery && onApply && <button type="button" className="db-sql-toolbar-btn" onClick={onApply}>复制到当前查询</button>}
    {toolbarExtra}
    {actions.ai && ai && <AiControlBar controller={ai.controller} connectionName={ai.connectionName} target={ai.target} onTakeover={ai.onTakeover} onReturnAi={ai.onReturnAi} />}
    {toolbarEnd}
  </div>
  return <ExecutionWorkbench
    className={className}
    toolbar={toolbar}
    editor={visible => <><div className="db-sql-editor"><SqlEditor value={sql} dialect={connection.dialect} schema={schema} connection={connection} cache={cache} visible={visible} onChange={onChange} onSelectionChange={onSelectionChange} onCursorChange={onCursorChange} onRun={(text, mode) => onRun?.(text, mode ?? (text?.trim() ? 'current' : 'all'))} onSave={onSave} /></div>{editorExtra}</>}
    result={resultFrame}
    rail={railRun}
    resultOpen={controlledOpen}
    onResultOpenChange={onResultOpenChange}
    editorOpen={controlledEditorOpen}
    onEditorOpenChange={onEditorOpenChange}
    editorRatio={controlledRatio}
    onRatioChange={onRatioChange}
  />
}

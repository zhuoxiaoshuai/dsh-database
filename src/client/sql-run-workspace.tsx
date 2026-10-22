import React, { useRef, useState } from 'react'
import { SqlEditor } from './editor.tsx'
import type { SchemaCache } from './schema/schema-cache.ts'
import { ExecutionWorkbench } from './workspace/source/execution-workbench.tsx'
import type { Connection } from '../shared/workbench.ts'
import { prepareSqlFormat } from '../shared/sql-format.ts'
import type { SqlEditorFormatRequest, SqlEditorHandle } from './sql/editor-format.ts'
import { AiControlBar } from './workspace/source/ai-control-bar.tsx'
import { ActionMenu } from './workspace/parts/overlay/action-menu.tsx'

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
  pending?: 'ai' | 'user'
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
  resultOpen: controlledOpen, resultKey,
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
  onFormat?(request: SqlEditorFormatRequest): Promise<void>
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
  resultKey?: string
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
  const formatRef = useRef<SqlEditorHandle>(null)
  const formatting = useRef<Promise<void>>()
  const [formatSelection, setFormatSelection] = useState(false)
  const [formatError, setFormatError] = useState('')

  const handleFormat = () => {
    if (formatting.current) return
    setFormatError('')
    const task = (async () => {
      const request = formatRef.current?.captureFormat()
      if (!request) throw new Error('编辑器尚未就绪。')
      if (request.range && !request.text.slice(request.range.from, request.range.to).trim()) return
      if (onFormat) { await onFormat(request); return }
      const result = prepareSqlFormat(request.text, connection.dialect, request.range)
      if (result.text === request.text) return
      request.apply(result)
      onChange(result.text)
    })().catch(error => setFormatError(error instanceof Error ? error.message : '格式化失败。'))
    formatting.current = task
    void task.finally(() => { if (formatting.current === task) formatting.current = undefined })
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
    {actions.cancel && onCancel && busy && <button type="button" className="db-sql-toolbar-btn" onClick={onCancel}>停止</button>}
    {actions.format && <button type="button" className="db-sql-toolbar-btn" disabled={busy} onClick={handleFormat}>{formatSelection ? '格式化选中' : '格式化全文'}</button>}
    {formatError && <span className="db-error" role="alert">{formatError}</span>}
    {actions.explain && onExplain && <button type="button" className="db-sql-toolbar-btn" disabled={explainDisabled} onClick={() => onExplain()}>解释</button>}
    {runProgress && <span className="db-muted db-sql-run-progress" role="status">{runProgress}</span>}
    <ActionMenu label="更多查询操作">
      {actions.runAll && <button role="menuitem" type="button" disabled={runDisabled} onClick={() => onRunAll?.()}>运行全部</button>}
      {actions.save && onSave && <button role="menuitem" type="button" disabled={saveDisabled} onClick={onSave}>保存</button>}
      {actions.clear && <button role="menuitem" type="button" disabled={busy || !sql} onClick={handleClear}>清空</button>}
    </ActionMenu>
    {actions.applyToQuery && onApply && <button type="button" className="db-sql-toolbar-btn" onClick={onApply}>复制到当前查询</button>}
    {toolbarExtra}
    {actions.ai && ai && <AiControlBar pending={ai.pending} controller={ai.controller} connectionName={ai.connectionName} target={ai.target} onTakeover={ai.onTakeover} onReturnAi={ai.onReturnAi} />}
    {toolbarEnd}
  </div>
  return <ExecutionWorkbench
    className={className}
    resultKey={resultKey}
    toolbar={toolbar}
    editor={visible => <><div className="db-sql-editor"><SqlEditor formatRef={formatRef} value={sql} dialect={connection.dialect} schema={schema} connection={connection} cache={cache} visible={visible} onChange={onChange} onSelectionChange={text => { setFormatSelection(text.length > 0); onSelectionChange?.(text) }} onCursorChange={onCursorChange} onRun={(text, mode) => onRun?.(text, mode ?? (text?.trim() ? 'current' : 'all'))} onSave={onSave} /></div>{editorExtra}</>}
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

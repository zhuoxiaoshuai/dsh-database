import React, { createContext, useContext, useEffect, useState } from 'react'
import { format } from 'sql-formatter'
import { SqlReceipts } from './sql/sql-receipts.tsx'
import { ReadonlyResultGrid, ResultExportButtons, resultSummary } from './results.tsx'
import { SqlRunWorkspace } from './sql-run-workspace.tsx'
import { QueryResultFrame } from './workspace/source/query-result-frame.tsx'
import { TableStructurePane } from './table-structure-pane.tsx'
import { SqlToolbarSchemaTable } from './sql-toolbar-schema-table.tsx'
import { SqlToolbarTemplatePicker } from './sql-toolbar-template-picker.tsx'
import type { SchemaCache } from './schema/schema-cache.ts'
import type { Connection, Result, SharedQuery, WorkspaceBridge } from '../shared/workbench.ts'
import type { ExecutionDocumentController } from './workspace/source/use-execution-document.ts'
import { dialectCapabilities } from '../shared/dialect-capabilities.ts'
import type { DisplayResult } from '../shared/execution.ts'
import { stripLeadingComments, unwrapExplainSql, wrapExplainSql } from '../shared/sql-text.ts'
import { resultTabLabel } from '../shared/sql-batch.ts'

type AiCollabProps = {
  bridge: WorkspaceBridge
  connection: Connection
  schema: string
  schemas?: string[]
  cache: SchemaCache
  documentController: ExecutionDocumentController
  onSchemaChange?(schema: string): void
  templateReloadKey?: number
  stale?: boolean
  display?: DisplayResult
  onRun(text: string): Promise<unknown>
  activeExecutionId?: string
  active?: boolean
}

type AiCollabContextValue = AiCollabProps & {
  query: SharedQuery
  selection: string
  setSelection: (value: string) => void
  busy: boolean
  result?: Result
  message: string
  messageError: boolean
  execute: (runSelection?: string) => Promise<void>
  explain: (runSelection?: string) => Promise<void>
  returnAi: () => Promise<void>
  onChange: (sql: string) => void
  formatCurrentQuery: () => Promise<void>
  abortRun: () => void
  takeOver: () => Promise<void>
  controller: 'ai' | 'user'
  activeExecutionId?: string
  stale?: boolean
  display?: DisplayResult
  changeSchema: (schema: string) => void
  insertSql: (sql: string) => void
  retrySave: () => void
}

const AiCollabContext = createContext<AiCollabContextValue | null>(null)

function useAiCollabContext(): AiCollabContextValue {
  const value = useContext(AiCollabContext)
  if (!value) throw new Error('AiCollab components must be used within AiCollabRoot')
  return value
}

function useAiCollabLogic(props: AiCollabProps): AiCollabContextValue {
  const { bridge, connection, cache, display, onRun, activeExecutionId, active = true } = props
  const collab = props.documentController
  const query: SharedQuery = { sql: collab.text, schema: collab.document.context.schema || '', revision: collab.document.revision,
    controller: collab.document.controller, controllerReason: collab.document.controllerReason }
  const [selection, setSelection] = useState('')
  const [message, setMessage] = useState('')
  const [messageError, setMessageError] = useState(false)
  const report = (text: string, error = false) => { setMessage(text); setMessageError(error) }
  const busy = collab.busy || !!activeExecutionId
  useEffect(() => {
    if (active && connection.live && query.schema) cache.prewarmSchema(connection, query.schema)
  }, [active, cache, connection, query.schema])
  const onChange = (sql: string) => { collab.edit(sql) }
  const changeSchema = (schema: string) => { collab.edit(collab.text, { schema }); props.onSchemaChange?.(schema) }
  const perform = async (text: string) => {
    if (busy || !connection.live || !text.trim()) return
    const outcome = await onRun(text) as { result?: Result; status?: string } | undefined
    if (outcome?.result) report(outcome.result.message || `成功 · ${outcome.result.rows.length} 行`, !!outcome.status && outcome.status !== 'succeeded')
  }
  const execute = (value?: string) => perform((value ?? selection).trim() || collab.text)
  const explain = async (value?: string) => {
    const text = (value ?? selection).trim() || collab.text
    if (!/^(with\b[\s\S]*\bselect\b|select\b)/i.test(stripLeadingComments(unwrapExplainSql(text)))) { report('解释仅支持 SELECT 查询。', true); return }
    await perform(wrapExplainSql(connection.dialect, text))
  }
  const formatCurrentQuery = async () => {
    try { await collab.formatText(sql => format(sql, { language: dialectCapabilities(connection.dialect).formatterLanguage })); report('SQL 已格式化，控制权保持不变。') }
    catch (error) { report(error instanceof Error ? error.message : '格式化失败。', true) }
  }
  const returnAi = async () => {
    try { await collab.returnToAi(); report('已归还 AI。') }
    catch (error) { report(error instanceof Error ? error.message : '归还失败。', true) }
  }
  return { ...props, query, schema: query.schema || '', selection, setSelection, busy, result: display?.result,
    message: collab.error || message, messageError: !!collab.error || messageError, execute, explain, returnAi, onChange,
    formatCurrentQuery, takeOver: async () => { try { await collab.takeOver() } catch (error) { report(error instanceof Error ? error.message : '接管失败。', true) } }, controller: collab.confirmedController, changeSchema, retrySave: collab.retrySave,
    insertSql: text => onChange(collab.text.trim() ? `${collab.text.replace(/\s+$/, '')}\n${text.trim()}` : text.trim()),
    abortRun: () => { if (activeExecutionId) void bridge.executions?.('execution-cancel', { executionId: activeExecutionId }) },
    activeExecutionId, display }
}
export function AiCollabRoot({ children, ...props }: AiCollabProps & { children: React.ReactNode }): React.ReactElement {
  const value = useAiCollabLogic(props)
  return <AiCollabContext.Provider value={value}>{children}</AiCollabContext.Provider>
}

export function AiCollabEditorPane({ onSave }: { onSave?(): void }): React.ReactElement {
  const {
    bridge, connection, schema, schemas, cache, query, controller, busy, message, messageError, result, display, templateReloadKey,
    execute, explain, returnAi, takeOver, onChange, formatCurrentQuery, setSelection, abortRun, changeSchema, insertSql, retrySave, documentController, stale,
  } = useAiCollabContext()
  const activeSchema = query.schema || schema
  const [resultOpen, setResultOpen] = useState(!!result || !!message)
  const [picked, setPicked] = useState('')
  const [showStructure, setShowStructure] = useState(false)
  const [resultTab, setResultTab] = useState('0')
  const [pane, setPane] = useState<'result' | 'message'>('result')
  const batch = result?.batch && result.batch.length > 1 ? result.batch : undefined
  const shown = batch ? (batch[Number(resultTab)] || batch[0]) : result
  useEffect(() => { setResultTab('0') }, [display?.executionId])
  const wrapRun = async (sel?: string) => { setResultOpen(true); await execute(sel) }
  const wrapExplain = async (sel?: string) => { setResultOpen(true); await explain(sel) }
  useEffect(() => { if (messageError && message) { setResultOpen(true); if (!result) setPane('message') } }, [message, messageError])
  return <SqlRunWorkspace
    className="db-ai-collab db-sql-run-workspace"
    connection={connection}
    schema={activeSchema}
    cache={cache}
    sql={query.sql}
    onChange={onChange}
    onSelectionChange={setSelection}
    onRun={text => void wrapRun(text)}
    onExplain={text => void wrapExplain(text)}
    busy={busy}
    onCancel={abortRun}
    onSave={onSave ? () => { if (query.sql.trim()) onSave() } : undefined}
    onClear={() => onChange('')}
    onFormat={() => { void formatCurrentQuery() }}
    resultKey={display?.executionId}
    resultOpen={resultOpen}
    onResultOpenChange={setResultOpen}
    actions={{
      run: true, cancel: true, save: !!onSave, format: true, clear: true, explain: true,
      applyToQuery: false, ai: true,
    }}
    toolbarExtra={connection.live && activeSchema ? <>
      <SqlToolbarSchemaTable
        connection={connection}
        schema={activeSchema}
        schemas={schemas && schemas.length ? schemas : [activeSchema]}
        cache={cache}
        onSchemaChange={changeSchema}
        picked={picked}
        onPickTable={name => { setPicked(name); setShowStructure(!!name) }}
      />
      {bridge.templates ? <SqlToolbarTemplatePicker
        bridge={bridge}
        connectionId={connection.id}
        dialect={connection.dialect}
        reloadKey={templateReloadKey}
        onInsert={insertSql}
      /> : null}
    </> : undefined}
    editorExtra={showStructure && picked ? <TableStructurePane onClose={() => setShowStructure(false)} cache={cache} connection={connection} schema={activeSchema} table={picked} /> : undefined}
    ai={{
      controller, pending: documentController.controlling,
      connectionName: connection.name,
      target: activeSchema || '未选库',
      onTakeover: () => void takeOver(),
      onReturnAi: () => void returnAi(),
    }}
    resultFrame={<QueryResultFrame
      secondaryHeader={<>{stale && display && <details className="db-result-snapshot"><summary>上次执行结果 · {display.identity?.context.schema || display.schema}</summary><pre>{display.executedSql}</pre></details>}{messageError && message && <p className="db-error" role="alert">{message}{documentController.saveFailed && <button type="button" onClick={retrySave}>重试保存</button>}</p>}</>}
      pane={shown ? pane : (message ? 'message' : 'result')}
      onPaneChange={shown ? setPane : undefined}
      resultTabs={batch ? batch.map((_, index) => ({ key: String(index), label: resultTabLabel(index, batch.length) })) : undefined}
      activeResultTab={resultTab}
      onResultTabChange={key => { setResultTab(key); setPane('result') }}
      summary={shown && pane === 'result' ? <span title={resultSummary(shown, [display?.kind === 'explain' ? 'Execution Plan' : '', message].filter(Boolean).join(' · '))}>{resultSummary(shown, [display?.kind === 'explain' ? 'Execution Plan' : '', message].filter(Boolean).join(' · '))}</span> : undefined}
      actions={shown ? <ResultExportButtons result={shown} /> : undefined}
      message={message && !messageError ? <p className="db-muted db-result-inline-note" role="status">{message}</p> : undefined}
    >
      {result?.steps?.length ? <SqlReceipts result={result} /> : shown ? <ReadonlyResultGrid result={shown} /> : null}
    </QueryResultFrame>}
  />
}


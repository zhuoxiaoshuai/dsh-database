import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import { format } from 'sql-formatter'
import { ReadonlyResultGrid, ResultExportButtons, resultSummary } from './results.tsx'
import { SqlRunWorkspace } from './sql-run-workspace.tsx'
import { QueryResultFrame } from './workspace/source/query-result-frame.tsx'
import { TableStructurePane } from './table-structure-pane.tsx'
import { SqlToolbarSchemaTable } from './sql-toolbar-schema-table.tsx'
import { SqlToolbarTemplatePicker } from './sql-toolbar-template-picker.tsx'
import type { SchemaCache } from './schema/schema-cache.ts'
import type { Connection, QueryEditSource, Result, SharedQuery, WorkspaceBridge } from '../shared/workbench.ts'
import { emptySharedQuery } from '../shared/workbench.ts'
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
  query: SharedQuery
  onQuery(next: SharedQuery): void
  onSchemaChange?(schema: string): void
  templateReloadKey?: number
  display?: DisplayResult
  onDisplay?(next?: DisplayResult): void
  markEditing?(value: boolean): void
  activeExecutionId?: string
  active?: boolean
}

type AiCollabContextValue = AiCollabProps & {
  selection: string
  setSelection: (value: string) => void
  busy: boolean
  result?: Result
  message: string
  messageError: boolean
  execute: (runSelection?: string, initiator?: 'ai' | 'user') => Promise<void>
  explain: (runSelection?: string) => Promise<void>
  returnAi: () => Promise<void>
  onChange: (sql: string, source?: QueryEditSource) => void
  abortRun: () => void
  takeOver: () => Promise<void>
  controller: 'ai' | 'user'
  activeExecutionId?: string
  display?: DisplayResult
  changeSchema: (schema: string) => void
  insertSql: (sql: string) => void
}

const AiCollabContext = createContext<AiCollabContextValue | null>(null)

function useAiCollabContext(): AiCollabContextValue {
  const value = useContext(AiCollabContext)
  if (!value) throw new Error('AiCollab components must be used within AiCollabRoot')
  return value
}

function useAiCollabLogic(props: AiCollabProps): AiCollabContextValue {
  const { bridge, connection, schema, cache, query, onQuery, display, onDisplay, markEditing, activeExecutionId, active = true } = props
  const activeSchema = query.schema || schema
  const [selection, setSelection] = useState('')
  const [localBusy, setLocalBusy] = useState(false)
  const [message, setMessage] = useState('AI 与用户共用此 SQL。用户改字即接管；点「归还 AI」后模型才能继续改写和自动执行。未选库时仍可编辑，运行前请先选择数据库。')
  const [messageError, setMessageError] = useState(false)
  const report = (text: string, error = false) => { setMessage(text); setMessageError(error) }
  const queryRef = useRef(query)
  queryRef.current = query
  const busy = localBusy || !!activeExecutionId
  useEffect(() => {
    if (active && connection.live && activeSchema) cache.prewarmSchema(connection, activeSchema)
  }, [active, cache, connection, activeSchema])
  useEffect(() => {
    if (display?.result) setLocalBusy(false)
  }, [display?.executionId, display?.result])
  const persistInflight = useRef(0)
  const persistIdle = useRef<ReturnType<typeof setTimeout>>()
  const settleEditing = () => {
    if (persistInflight.current > 0) return
    if (persistIdle.current) clearTimeout(persistIdle.current)
    persistIdle.current = setTimeout(() => {
      persistIdle.current = undefined
      if (persistInflight.current === 0) markEditing?.(false)
    }, 400)
  }
  useEffect(() => () => { if (persistIdle.current) clearTimeout(persistIdle.current) }, [])
  const persist = async (patch: Partial<SharedQuery>, source: QueryEditSource) => {
    const guardsEditing = source === 'user'
    if (guardsEditing) {
      persistInflight.current += 1
      markEditing?.(true)
    }
    try {
      const body = await bridge.executions!('shared-query-update', { id: connection.id, patch, source, revision: queryRef.current.revision })
      const next = (body as { sharedQuery?: SharedQuery }).sharedQuery
      if (next) onQuery(next)
      return next
    } finally {
      if (guardsEditing) {
        persistInflight.current = Math.max(0, persistInflight.current - 1)
        settleEditing()
      }
    }
  }
  const onChange = (sql: string, source: QueryEditSource = 'user') => {
    if (sql === queryRef.current.sql) return
    if (source === 'user') markEditing?.(true)
    const controller = source === 'user' ? 'user' as const : queryRef.current.controller
    const optimistic = { ...queryRef.current, sql, controller, revision: queryRef.current.revision + 1 }
    onQuery(optimistic)
    void persist({ sql, schema: activeSchema }, source).catch(error => report(error instanceof Error ? error.message : '无法保存 AI Query', true))
  }
  const changeSchema = (next: string) => {
    if (!next || next === activeSchema) {
      props.onSchemaChange?.(next)
      return
    }
    markEditing?.(true)
    const optimistic = { ...queryRef.current, schema: next, controller: 'user' as const, revision: queryRef.current.revision + 1 }
    onQuery(optimistic)
    props.onSchemaChange?.(next)
    void persist({ schema: next, sql: queryRef.current.sql }, 'user').catch(error => report(error instanceof Error ? error.message : '无法切换数据库', true))
  }
  const insertSql = (text: string) => {
    const chunk = text.trim()
    if (!chunk) return
    const prev = queryRef.current.sql
    onChange(prev.trim() ? `${prev.replace(/\s+$/, '')}\n${chunk}` : chunk, 'user')
  }
  const execute = async (runSelection?: string, initiator: 'ai' | 'user' = 'user') => {
    if (!connection.live) return
    const text = (runSelection ?? selection).trim() || queryRef.current.sql.trim()
    if (!text || busy) return
    setLocalBusy(true)
    try {
      if (initiator === 'user' && queryRef.current.controller !== 'user') {
        const body = await bridge.executions!('shared-query-control', { id: connection.id, controller: 'user', reason: 'user-run' })
        const next = (body as { sharedQuery?: SharedQuery }).sharedQuery
        if (next) onQuery(next)
      }
      const outcome = await bridge.executions!('shared-query-run', {
        id: connection.id,
        generation: connection.generation,
        schema: queryRef.current.schema || schema,
        sql: text,
        revision: queryRef.current.revision,
        initiator,
      }) as { result?: Result; status?: string; executionId?: string; sql?: string; error?: string }
      if (outcome.result && onDisplay && outcome.executionId) {
        onDisplay({
          connectionId: connection.id,
          executionId: outcome.executionId,
          queryRevision: queryRef.current.revision,
          executedSql: text,
          result: outcome.result,
          kind: 'query',
        })
        report(outcome.result.message || `成功 · ${outcome.result.rows.length} 行`)
      }
    } catch (error) {
      report(error instanceof Error ? error.message : '执行失败', true)
    } finally {
      setLocalBusy(false)
    }
  }
  const explain = async (runSelection?: string) => {
    if (!connection.live) return
    const text = (runSelection ?? selection).trim() || queryRef.current.sql.trim()
    if (!text || busy) return
    const inner = stripLeadingComments(unwrapExplainSql(text))
    if (!/^(with\b[\s\S]*\bselect\b|select\b)/i.test(inner)) {
      report('解释仅支持 SELECT 查询。', true)
      return
    }
    setLocalBusy(true)
    try {
      const outcome = await bridge.executions!('shared-query-explain', {
        id: connection.id,
        generation: connection.generation,
        schema: queryRef.current.schema || schema,
        sql: wrapExplainSql(connection.dialect, text),
      }) as unknown as Result & { executionId?: string }
      if (outcome?.columns && onDisplay) {
        onDisplay({
          connectionId: connection.id,
          executionId: outcome.executionId || `explain:${Date.now()}`,
          queryRevision: queryRef.current.revision,
          executedSql: text,
          result: outcome,
          kind: 'explain',
        })
        report(outcome.message || `执行计划 · ${outcome.rows.length} 行`)
      }
    } catch (error) {
      report(error instanceof Error ? error.message : '解释失败', true)
    } finally {
      setLocalBusy(false)
    }
  }
  const returnAi = async () => {
    onQuery({ ...queryRef.current, controller: 'ai' })
    report('已归还 AI。下次对话时模型将读取当前 SQL 和最新结果继续任务。')
    try {
      const body = await bridge.executions!('shared-query-control', { id: connection.id, controller: 'ai' })
      const next = (body as { sharedQuery?: SharedQuery }).sharedQuery
      if (next) onQuery(next)
    } catch (error) {
      onQuery({ ...queryRef.current, controller: 'user' })
      report(error instanceof Error ? error.message : '归还 AI 失败，请重试', true)
    }
  }
  const takeOver = async () => {
    const body = await bridge.executions!('shared-query-control', { id: connection.id, controller: 'user', reason: 'user-takeover' })
    const next = (body as { sharedQuery?: SharedQuery }).sharedQuery
    if (next) onQuery(next)
  }
  const controller = query.controller || emptySharedQuery().controller
  return {
    ...props,
    selection,
    setSelection,
    busy,
    result: display?.result,
    message,
    messageError,
    execute,
    explain,
    returnAi,
    onChange,
    abortRun: () => { if (activeExecutionId) void bridge.executions!('execution-cancel', { executionId: activeExecutionId }) },
    takeOver,
    controller,
    changeSchema,
    insertSql,
    activeExecutionId,
    display,
  }
}

export function AiCollabRoot({ children, ...props }: AiCollabProps & { children: React.ReactNode }): React.ReactElement {
  const value = useAiCollabLogic(props)
  return <AiCollabContext.Provider value={value}>{children}</AiCollabContext.Provider>
}

export function AiCollabEditorPane({ onSave }: { onSave?(): void }): React.ReactElement {
  const {
    bridge, connection, schema, schemas, cache, query, controller, busy, message, messageError, result, display, templateReloadKey,
    execute, explain, returnAi, takeOver, onChange, setSelection, abortRun, changeSchema, insertSql,
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
  useEffect(() => { if (result) setResultOpen(true) }, [result])
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
    onFormat={() => {
      try {
        const language = dialectCapabilities(connection.dialect).formatterLanguage
        onChange(format(query.sql, { language }), 'format')
      } catch { /* keep */ }
    }}
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
    editorExtra={showStructure && picked ? <TableStructurePane cache={cache} connection={connection} schema={activeSchema} table={picked} /> : undefined}
    ai={{
      controller,
      connectionName: connection.name,
      target: activeSchema || '未选库',
      onTakeover: () => void takeOver(),
      onReturnAi: () => void returnAi(),
    }}
    resultFrame={<QueryResultFrame
      pane={shown ? pane : (message ? 'message' : 'result')}
      onPaneChange={shown ? setPane : undefined}
      resultTabs={batch ? batch.map((_, index) => ({ key: String(index), label: resultTabLabel(index, batch.length) })) : undefined}
      activeResultTab={resultTab}
      onResultTabChange={key => { setResultTab(key); setPane('result') }}
      summary={shown && pane === 'result' ? <span title={resultSummary(shown, [display?.kind === 'explain' ? 'Execution Plan' : '', message].filter(Boolean).join(' · '))}>{resultSummary(shown, [display?.kind === 'explain' ? 'Execution Plan' : '', message].filter(Boolean).join(' · '))}</span> : undefined}
      actions={shown ? <ResultExportButtons result={shown} /> : undefined}
      message={message ? <p className={messageError ? 'db-error' : 'db-muted db-result-inline-note'} role="status">{message}</p> : undefined}
    >
      {shown ? <ReadonlyResultGrid result={shown} /> : null}
    </QueryResultFrame>}
  />
}


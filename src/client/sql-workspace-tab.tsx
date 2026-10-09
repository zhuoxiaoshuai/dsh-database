import React, { useEffect, useRef, useState } from 'react'
import { UnknownGridNotice } from './sql/unknown-grid-notice.tsx'
import { SqlReceipts } from './sql/sql-receipts.tsx'
import { SqlRunWorkspace } from './sql-run-workspace.tsx'
import { SaveExperienceDialog } from './save-experience-dialog.tsx'
import { publishExperienceFromSql } from '../shared/publish-experience.ts'
import { isBinaryCell } from './data-grid.tsx'
import { QueryResultFrame } from './workspace/source/query-result-frame.tsx'
import { QueryResultGrid } from './query-result-grid.tsx'
import { TableStructurePane } from './table-structure-pane.tsx'
import { SqlToolbarSchemaTable } from './sql-toolbar-schema-table.tsx'
import { SqlToolbarTemplatePicker } from './sql-toolbar-template-picker.tsx'
import { ConfirmWriteDialog } from './confirm-write-dialog.tsx'
import { executeDmlOp, type DmlOp } from './execute-dml.ts'
import { useGridSave } from './sql/use-grid-save.ts'
import { ownsSqlRun, canReplaySqlRun, type SqlRunSnapshot } from './sql/run-snapshot.ts'
import type { SchemaCache } from './schema/schema-cache.ts'
import { createSqlBatch, formatSqlBatchStatus, resultTabLabel, runSqlBatch, statementKindLabel, stepStatusLabel, resolveRunStatements, type SqlStep } from '../shared/sql-batch.ts'
import { isWritableEnvironment, type Connection, type Result, type WorkspaceBridge } from '../shared/workbench.ts'
import { stripLeadingComments, unwrapExplainSql, wrapExplainSql } from '../shared/sql-text.ts'
import { commitCellChange, rowKey as gridRowKey, selectedCellValue as gridSelectedCellValue } from './editable-grid-state.ts'
import { SQL_SPLIT_RATIO_DEFAULT } from './sql-pane-layout.ts'
import { MaintenanceToggle } from './maintenance-toggle.tsx'
import { ResultExportButtons } from './results.tsx'
import { unavailableMaintenanceCapability, type MaintenanceCapability } from '../shared/maintenance-capability.ts'

export function SqlWorkspaceTab({
  bridge, connection, schema, schemas, cache, initialSql, tabId, tabName, savedExperience, templateReloadKey, active = true, onStatus, onSql, onSavedExperience, onSavedToLibrary, onSchemaChange,
}: {
  bridge: WorkspaceBridge
  connection: Connection
  schema: string
  schemas: string[]
  cache: SchemaCache
  initialSql: string
  tabId?: string
  tabName?: string
  savedExperience?: boolean
  templateReloadKey?: number
  active?: boolean
  onStatus(status: { rows?: number; elapsedMs?: number; failed?: boolean; message?: string }): void
  onSql(sql: string): void
  onSavedExperience(): void
  onSavedToLibrary?(templateId: string): void
  onSchemaChange(schema: string): void
}) {
  const [sql, setSql] = useState(initialSql)
  useEffect(() => { setSql(initialSql) }, [tabId])
  const [selection, setSelection] = useState('')
  const cursorRef = useRef(0)
  const [busy, setBusy] = useState(false)
  const [pane, setPane] = useState<'result' | 'message'>('message')
  const [steps, setSteps] = useState<SqlStep[]>([])
  const [activeStep, setActiveStep] = useState(0)
  const [message, setMessage] = useState('')
  const [resultOpen, setResultOpen] = useState(false)
  const [ratio, setRatio] = useState(SQL_SPLIT_RATIO_DEFAULT)
  const tabRef = useRef<HTMLDivElement>(null)
  const [picked, setPicked] = useState('')
  const [showStructure, setShowStructure] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveBusy, setSaveBusy] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState('')
  const [dirty, setDirty] = useState(!savedExperience)
  const running = useRef<AbortController | null>(null)
  const onSqlRef = useRef(onSql)
  onSqlRef.current = onSql
  const writable = isWritableEnvironment(connection.environment)
  const [maintenance, setMaintenance] = useState(false)
  const [capability, setCapability] = useState<MaintenanceCapability>()
  const [capabilityBusy, setCapabilityBusy] = useState(false)
  const [changed, setChanged] = useState<Record<string, Record<string, string | null>>>({})
  const [draftRows, setDraftRows] = useState<{ id: string; values: Record<string, string | null> }[]>([])
  const [editing, setEditing] = useState<{ row: number; col: number }>()
  const [gridHint, setGridHint] = useState('')
  const gridSave = useGridSave()
  const { saving, confirmWrite, setConfirmWrite, saveOps, uncertainSave, unknownWrite } = gridSave
  const lastRun = useRef('')
  const verificationRead = useRef<{ sql: string; schema: string }>()
  const runSeq = useRef(0)
  const viewIdentity = JSON.stringify([connection.id, connection.generation, schema, tabId, active])
  const viewRef = useRef(viewIdentity)
  const capabilitySeq = useRef(0)
  const [resultSnapshot, setResultSnapshot] = useState<SqlRunSnapshot>()
  const snapshotRef = useRef<SqlRunSnapshot>()
  if (viewRef.current !== viewIdentity) {
    viewRef.current = viewIdentity; runSeq.current += 1; capabilitySeq.current += 1
    running.current?.abort()
  }
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; runSeq.current += 1 } }, [])
  const ownsSnapshot = (snapshot?: SqlRunSnapshot): boolean => ownsSqlRun(snapshot, viewRef.current, runSeq.current, mounted.current)
  const staleResult = !!resultSnapshot && !ownsSnapshot(resultSnapshot)
  useEffect(() => {
    setMaintenance(false); setCapability(undefined); setCapabilityBusy(false); setBusy(false)
    setEditing(undefined); setConfirmWrite(false)
  }, [viewIdentity])
  const result = steps[activeStep]?.result
  const singleSelect = steps.length === 1 && steps[0]?.status === 'ok' && steps[0]?.kind === 'select'
  useEffect(() => { onSqlRef.current(sql); setDirty(true) }, [sql])
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (!sql.trim() || saveBusy) return
        setSaveError('')
        setSaveOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, sql, saveBusy])
  useEffect(() => {
    if (!active) running.current?.abort()
    return () => { running.current?.abort() }
  }, [active])
  const pickTable = (name: string) => {
    setPicked(name)
    setShowStructure(!!name)
  }
  const insertTemplateSql = (text: string) => {
    const chunk = text.trim()
    if (!chunk) return
    setSql(prev => (prev.trim() ? `${prev.replace(/\s+$/, '')}\n${chunk}` : chunk))
  }
  const detectEditable = async (runText: string, next: Result, target = schema, snapshot = snapshotRef.current) => {
    if (!ownsSnapshot(snapshot)) return
    const check = ++capabilitySeq.current
    setCapabilityBusy(true)
    try {
      const value = await bridge.maintenance!(connection, { kind: 'capability', source: 'query', schema: target, sql: runText, resultColumns: next.columns })
      if (!ownsSnapshot(snapshot) || check !== capabilitySeq.current) return
      setCapability(value as MaintenanceCapability)
    } catch (error) {
      if (!ownsSnapshot(snapshot) || check !== capabilitySeq.current) return
      setCapability(unavailableMaintenanceCapability('query', error instanceof Error ? error.message : '无法检查维护能力。'))
    } finally {
      if (ownsSnapshot(snapshot) && check === capabilitySeq.current) setCapabilityBusy(false)
    }
  }
  const runSql = async (text: string, signal: AbortSignal, target = schema) => {
    return (bridge.executeManual || bridge.execute)({ ...connection, database: target }, text, signal)
  }
  const applyBatch = (next: SqlStep[], seq: number, current = 0) => {
    if (seq !== runSeq.current) return
    setSteps(next)
    setActiveStep(Math.min(Math.max(0, current), Math.max(0, next.length - 1)))
    const summary = formatSqlBatchStatus(next, next.some(step => step.status === 'running'))
    const failed = next.some(step => step.status === 'failed')
    const lastOk = [...next].reverse().find(step => step.status === 'ok')
    onStatus({
      rows: lastOk?.result?.affectedRows ?? lastOk?.result?.rows.length,
      elapsedMs: next.reduce((sum, step) => sum + (step.result?.elapsedMs ?? 0), 0),
      failed,
      message: summary,
    })
  }
  const runBatch = async (nextSteps: SqlStep[], opts?: { from?: number; only?: number; explain?: boolean; target?: string; verifyUnknown?: boolean }) => {
    if (!nextSteps.length) return
    if (staleResult && !opts?.verifyUnknown && (Object.keys(changed).length || draftRows.length)) { setGridHint('原目标的网格草稿已冻结，请先撤销修改，再在当前目标重新查询。'); return }
    const target = opts?.target ?? schema
    if (target !== schema) { setGridHint('请先选择原执行目标，再刷新核验。'); return }
    if (uncertainSave.current && !opts?.verifyUnknown) { setGridHint('请先通过未知写入核验入口丢弃旧草稿并刷新。'); return }
    running.current?.abort()
    const controller = new AbortController(); running.current = controller
    const seq = ++runSeq.current
    const snapshot = { identity: viewRef.current, schema: target, seq, connectionId: connection.id, generation: connection.generation, statements: nextSteps.map(step => step.sql) }
    snapshotRef.current = snapshot; setResultSnapshot(snapshot); capabilitySeq.current += 1
    setBusy(true)
    setSteps(nextSteps)
    setActiveStep(opts?.only ?? opts?.from ?? 0)
    setPane('result')
    setResultOpen(true)
    if (maintenance) await bridge.maintenance!(connection, { kind: 'enable', enabled: false }).catch(() => {})
    if (!ownsSnapshot(snapshot)) return
    setMaintenance(false)
    setGridHint(''); setChanged({}); setDraftRows([]); setEditing(undefined); setCell(undefined)
    setCapability(undefined)
    setMessage('')
    try {
      const finished = await runSqlBatch({
        steps: nextSteps,
        from: opts?.from,
        only: opts?.only,
        signal: controller.signal,
        execute: (text, signal) => runSql(text, signal, target),
        onChange: live => {
          const current = live.findIndex(step => step.status === 'running')
          const fallback = [...live].findLastIndex(step => step.status === 'ok' || step.status === 'failed' || step.status === 'cancelled' || step.status === 'unknown')
          applyBatch(live, seq, current >= 0 ? current : fallback)
        },
      })
      if (!ownsSnapshot(snapshot)) return
      const failedIndex = finished.findIndex(step => step.status === 'failed' || step.status === 'cancelled' || step.status === 'unknown')
      const firstGrid = finished.findIndex(step => step.status === 'ok' && (step.result?.columns.length || 0) > 0)
      applyBatch(finished, seq, opts?.only ?? (failedIndex >= 0 ? failedIndex : firstGrid >= 0 ? firstGrid : finished.length - 1))
      const focused = finished[opts?.only ?? 0]
      lastRun.current = focused?.sql || nextSteps[0]?.sql || ''
      if (!opts?.explain && finished.length === 1 && finished[0]?.status === 'ok' && finished[0].kind === 'select' && finished[0].result) {
        gridSave.verifiedRead()
        void detectEditable(stripLeadingComments(finished[0].sql), finished[0].result, target, snapshot)
      }
      setPane(finished.some(step => step.status === 'failed' || step.status === 'unknown') ? 'message' : 'result')
      setMessage(finished.map((step, index) => {
        const head = `${index + 1} · ${statementKindLabel(step.kind)} · ${stepStatusLabel(step.status)}`
        const body = step.error || step.result?.message || ''
        return `${head}${body ? `\n${body}` : ''}`
      }).join('\n\n'))
    } finally {
      if (running.current === controller) running.current = null
      if (seq === runSeq.current) setBusy(false)
    }
  }
  const execute = async (runSelection?: string, mode: 'current' | 'all' = 'all') => {
    if (busy) return
    const ranges = resolveRunStatements({
      sql,
      dialect: connection.dialect,
      selection: runSelection ?? selection,
      cursor: cursorRef.current,
      mode: mode === 'all' ? 'all' : 'selection-or-current',
    })
    if (!ranges.length) return
    await runBatch(createSqlBatch(ranges.map(item => item.sql)))
  }
  const retryOne = (index: number) => {
    const original = snapshotRef.current
    if (!canReplaySqlRun(original, viewRef.current, runSeq.current, mounted.current, steps.map(step => step.sql))) { setMessage('原运行目标或连接已变化，请主动发起新的执行。'); setPane('message'); return }
    if (steps[index]?.status === 'unknown' || (steps[index]?.status === 'ok' && ['insert', 'update', 'delete'].includes(steps[index]?.kind))) { setMessage('不能重复提交成功或未知的写入，请核验后重新编辑。'); return }
    const next = steps.map((step, i) => i === index ? { ...step, status: 'pending' as const, error: undefined, result: undefined } : step)
    void runBatch(next, { only: index, target: original!.schema })
  }
  const continueFrom = (index: number) => {
    const original = snapshotRef.current
    if (!canReplaySqlRun(original, viewRef.current, runSeq.current, mounted.current, steps.map(step => step.sql))) { setMessage('原运行目标或连接已变化，请主动发起新的执行。'); setPane('message'); return }
    if (steps.slice(index).some(step => step.status === 'unknown' || (step.status === 'ok' && ['insert', 'update', 'delete'].includes(step.kind)))) { setMessage('后续包含成功或未知的写入，请核验后重新编辑。'); return }
    const next = steps.map((step, i) => i < index ? step : { ...step, status: 'pending' as const, error: undefined, result: i === index ? undefined : step.result })
    void runBatch(next, { from: index, target: original!.schema })
  }
  const explain = async (runSelection?: string) => {
    const ranges = resolveRunStatements({
      sql,
      dialect: connection.dialect,
      selection: runSelection ?? selection,
      cursor: cursorRef.current,
      mode: 'selection-or-current',
    })
    const text = ranges[0]?.sql || ''
    if (!text.trim() || busy) return
    const inner = stripLeadingComments(unwrapExplainSql(text))
    if (!/^(with\b[\s\S]*\bselect\b|select\b)/i.test(inner)) {
      setPane('message')
      setMessage('解释仅支持 SELECT 查询。')
      setResultOpen(true)
      onStatus({ failed: true, message: '解释仅支持 SELECT' })
      return
    }
    await runBatch(createSqlBatch([wrapExplainSql(connection.dialect, text)]), { explain: true })
  }
  const [cell, setCell] = useState<{ row: number; col: number }>()
  const discardEdits = () => {
    const uncertain = gridSave.discard()
    setChanged({})
    setDraftRows([])
    setEditing(undefined)
    setGridHint('已撤销本页未保存修改。')
    if (uncertain && verificationRead.current) { setMaintenance(false); void runBatch(createSqlBatch([verificationRead.current.sql]), { target: verificationRead.current.schema, verifyUnknown: true }) }
  }
  const enableMaintenance = async () => {
    if (!ownsSnapshot(snapshotRef.current)) { setGridHint('这是原目标的只读结果，请在当前目标重新查询。'); return }
    const snapshot = snapshotRef.current
    if (uncertainSave.current) { setGridHint('结果未知，先丢弃旧草稿并成功刷新。'); return }
    setBusy(true)
    try {
      const next = !maintenance
      const value = await bridge.maintenance!(connection, { kind: 'enable', enabled: next, capabilityId: next ? capability?.id : undefined })
      if (!ownsSnapshot(snapshot)) return
      setMaintenance(!!value.enabled)
      if (!value.enabled) {
        setChanged({}); setDraftRows([]); setEditing(undefined); setCell(undefined)
        setConfirmWrite(false); saveOps.current = []
        setCapability(undefined)
        if (result && lastRun.current) void detectEditable(lastRun.current, result)
      }
    }
    catch (e) { if (ownsSnapshot(snapshot)) setGridHint(e instanceof Error ? e.message : '无法切换维护') }
    finally { if (ownsSnapshot(snapshot)) setBusy(false) }
  }
  const keyColumns = capability?.resultPrimaryKeys || []
  const editableResultColumns = capability?.columns.filter(column => column.editable).map(column => column.resultColumn) || []
  const insertableResultColumns = capability?.columns.filter(column => column.sourceColumn && !capability.identityColumns.includes(column.sourceColumn)).map(column => column.resultColumn) || []
  const identityResultColumns = capability?.columns.filter(column => column.sourceColumn && capability.identityColumns.includes(column.sourceColumn)).map(column => column.resultColumn) || []
  const sourceColumn = (resultColumn: string) => capability?.columns.find(column => column.resultColumn === resultColumn)?.sourceColumn
  const sourceObject = (row: (string | null)[]) => Object.fromEntries(result?.columns.flatMap((column, index) => {
    const source = sourceColumn(column)
    return source ? [[source, row[index] ?? null] as const] : []
  }) || [])
  const sourceValues = (values: Record<string, string | null>) => Object.fromEntries(Object.entries(values).flatMap(([column, value]) => {
    const source = sourceColumn(column)
    return source ? [[source, value] as const] : []
  }))
  const rowKey = (row: (string | null)[], index: number) => {
    if (!result) return ''
    return gridRowKey(result, keyColumns, row, index)
  }
  const commitCell = (pos: { row: number; col: number }, value: string | null) => {
    if (!ownsSnapshot(snapshotRef.current)) return
    if (!result) return
    setEditing(undefined)
    setChanged(old => commitCellChange(result, keyColumns, old, pos, value))
  }
  const selectedCellValue = () => {
    if (!result || cell == null) return undefined
    if (cell.row < 0) return draftRows[-cell.row - 1]?.values[result.columns[cell.col]]
    return gridSelectedCellValue(result, keyColumns, changed, cell, false)
  }
  const addRow = () => {
    if (!ownsSnapshot(snapshotRef.current)) return
    if (uncertainSave.current) return
    if (!result || !capability?.canInsert) return
    setDraftRows(old => [...old, { id: crypto.randomUUID(), values: {} }])
  }
  const deleteSelected = () => {
    if (!ownsSnapshot(snapshotRef.current)) return
    if (uncertainSave.current) return
    if (!result || !capability?.canDelete || cell == null || cell.row < 0) return
    const snapshot = snapshotRef.current
    gridSave.prepare([{ kind: 'delete', values: {}, original: sourceObject(result.rows[cell.row]) }], () => ownsSnapshot(snapshot))
  }
  const save = () => {
    if (!ownsSnapshot(snapshotRef.current)) { setGridHint('原结果与草稿已冻结，请撤销修改并重新查询。'); return }
    if (uncertainSave.current) { setGridHint('上次写入结果未知，请核验并撤销旧草稿、刷新结果后重新编辑。'); return }
    if (!result || !maintenance) { setGridHint('请先开启维护模式。'); return }
    if (!capability?.canEnable || !capability.table) { setGridHint(capability?.reason || '当前结果不能保存。'); return }
    const ops: DmlOp[] = []
    for (const draft of draftRows) ops.push({ kind: 'insert', draftId: draft.id, values: sourceValues(draft.values) })
    for (const [key, values] of Object.entries(changed)) {
      const index = result.rows.findIndex((item, i) => rowKey(item, i) === key)
      if (index >= 0) ops.push({ kind: 'update', rowKey: key, values: sourceValues(values), original: sourceObject(result.rows[index]) })
    }
    if (ops.some(op => op.kind === 'insert' && !Object.keys(op.values).length)) { setGridHint('新增行没有可提交字段，请填写字段或删除该草稿。'); return }
    if (!ops.length) { setGridHint('没有待保存的修改。'); return }
    const snapshot = snapshotRef.current
    gridSave.prepare(ops, () => ownsSnapshot(snapshot))
  }
  const confirmSave = async () => {
    const snapshot = snapshotRef.current
    if (!ownsSnapshot(snapshot)) { setConfirmWrite(false); setGridHint('执行目标已变化，旧草稿不能提交。'); return }
    if (uncertainSave.current) { setGridHint('上次写入结果未知，不能再次提交旧草稿。'); setConfirmWrite(false); return }
    if (!capability?.table) return
    setGridHint('')
    await gridSave.submit({
      current: () => ownsSnapshot(snapshot),
      execute: op => executeDmlOp(bridge, connection, snapshot!.schema, capability.table!, op, () => ownsSnapshot(snapshot)),
      committed: op => {
        if (op.draftId) setDraftRows(rows => rows.filter(row => row.id !== op.draftId))
        if (op.rowKey) setChanged(rows => { const next = { ...rows }; delete next[op.rowKey!]; return next })
      },
      success: () => {
        setChanged({}); setDraftRows([]); setEditing(undefined)
        if (ownsSnapshot(snapshot) && lastRun.current) void runBatch(createSqlBatch([lastRun.current]))
      },
      failure: error => {
        if ((error as { effect?: string })?.effect === 'unknown') verificationRead.current = { sql: lastRun.current, schema: snapshot!.schema }
        setGridHint(error instanceof Error ? error.message : '保存失败')
      },
    })
  }

  useEffect(() => {
    if (active && connection.live && schema) cache.prewarmSchema(connection, schema)
  }, [active, cache, connection, schema])
  return <div className="db-sql-tab" ref={tabRef}>
    {staleResult && <p role="status" className="db-muted">原目标 {resultSnapshot?.schema} 的结果仅供查看；网格草稿已冻结，请撤销修改并在当前目标重新查询。</p>}
    {unknownWrite && <UnknownGridNotice snapshot={unknownWrite} connection={connection} onOpenTarget={() => onSchemaChange(unknownWrite.schema)} onRefresh={discardEdits} />}
    <SqlRunWorkspace
      className="db-sql-run-workspace"
      connection={connection}
      schema={schema}
      cache={cache}
      sql={sql}
      onChange={setSql}
      onSelectionChange={setSelection}
      onCursorChange={offset => { cursorRef.current = offset }}
      onRun={(text, mode) => void execute(text, mode === 'current' ? 'current' : 'all')}
      onExplain={text => void explain(text)}
      busy={busy}
      runProgress={busy ? formatSqlBatchStatus(steps, true) : undefined}
      hasSelection={!!selection.trim()}
      onCancel={() => running.current?.abort()}
      onClear={() => { setSql(''); setSteps([]); setMessage(''); setResultOpen(false) }}
      onSave={() => { if (!sql.trim()) return; setSaveError(''); setSaveOpen(true) }}
      resultOpen={resultOpen}
      onResultOpenChange={setResultOpen}
      editorRatio={ratio}
      onRatioChange={setRatio}
      actions={{ ai: false, applyToQuery: false, runAll: false }}
      toolbarEnd={!dirty && savedExperience ? <span className="db-muted db-toolbar-status">已保存到经验库</span> : undefined}
      toolbarExtra={<>
        {connection.live && schema ? <SqlToolbarSchemaTable
          connection={connection}
          schema={schema}
          schemas={schemas}
          cache={cache}
          onSchemaChange={onSchemaChange}
          picked={picked}
          onPickTable={pickTable}
        /> : null}
        {bridge.templates ? <SqlToolbarTemplatePicker
          bridge={bridge}
          connectionId={connection.id}
          dialect={connection.dialect}
          reloadKey={templateReloadKey}
          onInsert={insertTemplateSql}
        /> : null}
      </>}
      editorExtra={showStructure && picked ? <TableStructurePane onClose={() => setShowStructure(false)} cache={cache} connection={connection} schema={schema} table={picked} /> : undefined}
      resultFrame={<QueryResultFrame
        pane={pane}
        onPaneChange={setPane}
        resultTabs={steps.length > 1 ? steps.map((_, index) => ({ key: String(index), label: resultTabLabel(index, steps.length) })) : undefined}
        activeResultTab={String(activeStep)}
        onResultTabChange={key => {
          setActiveStep(Number(key))
          setPane('result')
          setCell(undefined)
          setEditing(undefined)
        }}
        summary={result && pane === 'result' ? <strong>{result.columns.length ? `${result.rows.length} 行 · ${result.elapsedMs} ms` : (result.message || `${result.elapsedMs} ms`)}</strong> : busy ? <span className="db-muted" role="status">{formatSqlBatchStatus(steps, true) || '正在执行…'}</span> : undefined}
        actions={<>
          {!writable && <span className="db-muted" role="status">人工 SQL · 写入受限</span>}
          {singleSelect && <MaintenanceToggle capability={capability} checking={capabilityBusy} enabled={maintenance} busy={busy}
            onToggle={() => void enableMaintenance()} onReason={setGridHint} />}
          {singleSelect && <button type="button" className="db-maintenance-small" title={capability?.insertReason} disabled={saving || !maintenance || !capability?.canInsert} onClick={addRow}>新增</button>}
          {singleSelect && <button type="button" className="db-maintenance-small" title={capability?.deleteReason} disabled={saving || !maintenance || !capability?.canDelete || cell == null || cell.row < 0} onClick={deleteSelected}>删除</button>}
          {singleSelect && <button type="button" className="db-maintenance-small" disabled={saving || !maintenance || (!Object.keys(changed).length && !draftRows.length)} onClick={save}>保存修改</button>}
          {singleSelect && !unknownWrite && <button type="button" className="db-maintenance-small" disabled={saving || (!Object.keys(changed).length && !draftRows.length)} onClick={discardEdits}>{uncertainSave.current ? '丢弃旧草稿并刷新' : '撤销修改'}</button>}
          {result?.columns.length ? <ResultExportButtons result={result} /> : null}
          {gridHint && <span className="db-muted db-query-result-hint" role="status" title={gridHint}>{gridHint}</span>}
        </>}
        message={steps.length ? <SqlReceipts localSteps={steps} actions={(step, index) => step.status === 'failed' && !busy ? <div className="db-sql-step-actions">
          <button type="button" onClick={() => retryOne(index)}>仅重试此条</button>
          {index < steps.length - 1 && <button type="button" onClick={() => continueFrom(index)}>从此条继续</button>}
        </div> : undefined} /> : <pre className="db-cell-detail">{message}</pre>}
      >
        {(() => {
          const step = steps[activeStep]
          if (!step) return null
          if (result && result.columns.length) {
            const detail = capability?.table ? cache.detailSnapshot(connection, capability.schema || schema, capability.table) : undefined
            const columnTypes = result.columns.map(name => {
              const source = capability?.columns.find(column => column.resultColumn === name)?.sourceColumn || name
              return String((detail?.columns || []).find(column => String(column.name) === source)?.type || '')
            })
            return <QueryResultGrid
              result={result} readOnly={staleResult || uncertainSave.current || !singleSelect || !writable || !maintenance || !capability?.canUpdate} allowInsert={!staleResult && !uncertainSave.current && !!singleSelect && writable && maintenance && !!capability?.canInsert} primaryKeys={keyColumns} changed={changed} draftRows={draftRows} selected={cell} editing={editing} autoIncrement={identityResultColumns} editableColumns={editableResultColumns} insertableColumns={insertableResultColumns}
              onSelect={setCell} onEditStart={pos => {
                if (!singleSelect) { setGridHint('批量结果仅支持查看，请单独运行该查询后再维护。'); return }
                if (pos.row >= 0 && !capability?.canUpdate) { setGridHint(capability?.updateReason || capability?.reason || '当前结果仅支持查看。'); return }
                if (pos.row < 0 && !capability?.canInsert) { setGridHint(capability?.insertReason || '当前结果不允许新增。'); return }
                if (!writable) { setGridHint('只读权限连接不支持网格维护。'); return }
                if (!maintenance) { setGridHint('请先开启维护模式。'); return }
                setEditing(pos); setCell(pos)
              }}
              onDetailEdit={setCell}
              onEditCommit={(pos, value) => commitCell(pos, value)} onEditCancel={() => setEditing(undefined)}
              onDraftChange={(id, column, value) => { setDraftRows(old => old.map(row => row.id === id ? { ...row, values: { ...row.values, [column]: value } } : row)); setEditing(undefined) }}
              onRowSelect={row => setCell({ row, col: 0 })}
              dialect={connection.dialect}
              schema={capability?.table ? (capability.schema || schema) : ''}
              table={capability?.table || ''}
              columnTypes={columnTypes}
              onCopyError={setGridHint}
              extraMenu={pos => {
                const column = result.columns[pos.col]
                const cellValue = pos.row < 0 ? draftRows[-pos.row - 1]?.values[column] ?? null : result.rows[pos.row]?.[pos.col] ?? null
                const allowed = ownsSnapshot(snapshotRef.current) && !uncertainSave.current && writable && maintenance && (pos.row < 0 ? insertableResultColumns : editableResultColumns).includes(column) && (pos.row < 0 ? capability?.canInsert : capability?.canUpdate) && !isBinaryCell(result, pos.col, cellValue)
                if (!allowed) return null
                return <>
                  {pos.row < 0 && <button type="button" onClick={() => setDraftRows(old => old.map((row, index) => { if (-(index + 1) !== pos.row) return row; const values = { ...row.values }; delete values[column]; return { ...row, values } }))}>使用默认值</button>}
                  <button type="button" onClick={() => pos.row < 0 ? setDraftRows(old => old.map((row, index) => -(index + 1) === pos.row ? { ...row, values: { ...row.values, [column]: null } } : row)) : commitCell(pos, null)}>设置为 NULL</button>
                  <button type="button" onClick={() => pos.row < 0 ? setDraftRows(old => old.map((row, index) => -(index + 1) === pos.row ? { ...row, values: { ...row.values, [column]: '' } } : row)) : commitCell(pos, '')}>设置为空字符串</button>
                </>
              }}
              detailColumn={cell != null ? result.columns[cell.col] : undefined}
              detailValue={cell != null ? selectedCellValue() : undefined}
              detailEditable={ownsSnapshot(snapshotRef.current) && !uncertainSave.current && !!singleSelect && writable && maintenance && cell != null && (cell.row < 0 ? !!capability?.canInsert && insertableResultColumns.includes(result.columns[cell.col] || '') : !!capability?.canUpdate && editableResultColumns.includes(result.columns[cell.col] || ''))}
              onDetailApply={text => {
                if (!cell) return
                if (cell.row < 0) {
                  const id = draftRows[-cell.row - 1]?.id
                  if (id) setDraftRows(old => old.map(row => row.id === id ? { ...row, values: { ...row.values, [result.columns[cell.col]]: text } } : row))
                } else commitCell(cell, text)
              }}
            />
          }
          return <pre className="db-cell-detail">{step.error || step.result?.message || (step.status === 'skipped' ? '未执行' : step.status === 'pending' || step.status === 'running' ? '执行中…' : '无结果集')}</pre>
        })()}
      </QueryResultFrame>}
    />
    {confirmWrite && <ConfirmWriteDialog
      busy={saving}
      error={gridHint}
      onCancel={() => { if (!saving) { setConfirmWrite(false); setGridHint('') } }}
      onConfirm={() => void confirmSave()}
    />}
    <SaveExperienceDialog
      open={saveOpen}
      busy={saveBusy}
      error={saveError}
      success={saveSuccess}
      defaultName={tabName || ''}
      onCancel={() => { setSaveOpen(false); setSaveError(''); setSaveSuccess('') }}
      onConfirm={name => {
        setSaveBusy(true)
        setSaveError('')
        setSaveSuccess('')
        void publishExperienceFromSql(bridge, { sql, dialect: connection.dialect, connectionId: connection.id, title: name }).then(outcome => {
          setSaveSuccess(outcome.merged ? '已合并到已有经验。' : '已创建新经验。')
          setDirty(false)
          try {
            onSavedExperience()
            onSavedToLibrary?.(outcome.id)
          } catch { /* 跳转失败不影响已保存 */ }
        }).catch(e => setSaveError(e instanceof Error ? e.message : '保存失败')).finally(() => setSaveBusy(false))
      }}
    />
  </div>
}

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { isBinaryPlaceholder, type DataGridHandle } from './data-grid.tsx'
import { QueryResultFrame } from './workspace/source/query-result-frame.tsx'
import { QueryResultGrid } from './query-result-grid.tsx'
import { ConfirmWriteDialog } from './confirm-write-dialog.tsx'
import { executeDmlOp, type DmlOp } from './execute-dml.ts'
import { composeTableSelect, isCatalogView, isWritableEnvironment, keepResultOnFailure, type CatalogResult, type Connection, type Result, type WorkspaceBridge } from '../shared/workbench.ts'
import { resolvePrimaryKeys } from '../shared/primary-keys.ts'
import type { SchemaCache } from './schema/schema-cache.ts'
import { indexRowsFromCatalog } from './catalog-indexes.ts'
import { commitCellChange, rowKey as gridRowKey, rowObject, selectedCellValue as gridSelectedCellValue } from './editable-grid-state.ts'
import { MaintenanceToggle } from './maintenance-toggle.tsx'
import { ResultExportButtons } from './results.tsx'
import { unavailableMaintenanceCapability, type MaintenanceCapability } from '../shared/maintenance-capability.ts'

export function ObjectWorkspace({
  bridge, connection, schema, table, isView, sub, cache, active = true, onSub, onStatus,
}: {
  bridge: WorkspaceBridge
  connection: Connection
  schema: string
  table: string
  isView: boolean
  sub: 'data' | 'columns' | 'indexes'
  cache?: SchemaCache
  active?: boolean
  onSub(sub: 'data' | 'columns' | 'indexes'): void
  onStatus(status: { rows?: number; elapsedMs?: number; failed?: boolean; message?: string }): void
}) {
  const [filter, setFilter] = useState('')
  const [applied, setApplied] = useState({ filter: '', sortField: '', sortOrder: null as 'ASC' | 'DESC' | null, page: 1 })
  const [result, setResult] = useState<Result>()
  const [detail, setDetail] = useState<CatalogResult>()
  const catalogView = (cache?.tablesSnapshot(connection, schema) || []).some(item => item.name.toLowerCase() === table.toLowerCase() && (item.kind === 'view' || isCatalogView(item.record.kind)))
  const viewOnly = isView || catalogView || isCatalogView(detail?.kind)
  const writable = isWritableEnvironment(connection.environment) && !viewOnly
  const [busy, setBusy] = useState(false)
  const [metaBusy, setMetaBusy] = useState(false)
  const [error, setError] = useState('')
  const [hint, setHint] = useState('')
  const [maintenance, setMaintenance] = useState(false)
  const [capability, setCapability] = useState<MaintenanceCapability>()
  const [capabilityBusy, setCapabilityBusy] = useState(false)
  const [capabilityEpoch, setCapabilityEpoch] = useState(0)
  const [saving, setSaving] = useState(false)
  const [changed, setChanged] = useState<Record<string, Record<string, string | null>>>({})
  const [draftRows, setDraftRows] = useState<{ id: string; values: Record<string, string | null> }[]>([])
  const [selected, setSelected] = useState<{ row: number; col: number }>()
  const [editing, setEditing] = useState<{ row: number; col: number }>()
  const [confirmWrite, setConfirmWrite] = useState(false)
  const [dataPane, setDataPane] = useState<'result' | 'message'>('result')
  const running = useRef<AbortController | null>(null)
  const requestSequence = useRef(0)
  const saveOps = useRef<DmlOp[]>([])
  const gridRef = useRef<DataGridHandle>(null)
  const restoreScroll = useRef<{ top: number; left: number } | null>(null)
  const keys = useMemo(() => resolvePrimaryKeys(connection.dialect, detail), [detail, connection.dialect])
  const rowKey = (row: (string | null)[], index: number) => {
    if (!result) return ''
    return gridRowKey(result, keys, row, index)
  }
  const hasUnsaved = () => Object.keys(changed).length > 0 || draftRows.length > 0
  const guardUnsaved = () => {
    if (!hasUnsaved()) return false
    setHint('有未保存的修改，请先保存或撤销后再刷新、筛选、排序或翻页。')
    return true
  }
  const discardEdits = () => {
    setChanged({})
    setDraftRows([])
    setEditing(undefined)
    setHint('已撤销本页未保存修改。')
  }
  const selectedValue = () => {
    if (!result || selected === undefined) return null
    if (selected.row < 0) return draftRows[-selected.row - 1]?.values[result.columns[selected.col]] ?? null
    return gridSelectedCellValue(result, keys, changed, selected)
  }
  const loadMeta = async (refresh = false) => {
    if (!connection.live) return
    setMetaBusy(true)
    try {
      setDetail(cache
        ? await cache.loadTable(connection, schema, table, { refresh })
        : await bridge.catalog!(connection, { kind: 'table', schema, table, refresh }))
    }
    catch (e) { setError(e instanceof Error ? e.message : '无法读取结构') }
    finally { setMetaBusy(false) }
  }
  const loadIndexes = async () => {
    if (!connection.live) return
    setMetaBusy(true)
    try {
      setDetail(cache
        ? await cache.loadIndexes(connection, schema, table)
        : { ...(detail || { collectedAt: '', source: '' }), ...await bridge.catalog!(connection, { kind: 'indexes', schema, table }) })
    }
    catch (e) { setError(e instanceof Error ? e.message : '无法读取索引') }
    finally { setMetaBusy(false) }
  }
  const loadData = async (state = applied, opts?: { keepScroll?: boolean }) => {
    if (!connection.live) return
    restoreScroll.current = opts?.keepScroll ? gridRef.current?.getScroll() ?? null : null
    running.current?.abort()
    const request = ++requestSequence.current
    const controller = new AbortController(); running.current = controller; setBusy(true); setError('')
    try {
      if (state.filter && /;/.test(state.filter)) throw new Error('Filter 无法组成合法单条 SELECT，未执行。')
      const sql = composeTableSelect(connection.dialect, schema, table, state)
      const next = await (bridge.executeManual || bridge.execute)({ ...connection, database: schema }, sql, controller.signal)
      if (request !== requestSequence.current) return
      setResult(next)
      setDataPane('result')
      onStatus({ rows: next.rows.length, elapsedMs: next.elapsedMs, failed: false, message: table })
    } catch (e) {
      if (request !== requestSequence.current) return
      const message = e instanceof Error ? e.message : '查询失败'
      if (!keepResultOnFailure(message)) setResult(undefined)
      setError(message)
      setDataPane('message')
      onStatus({ failed: true, message })
    } finally {
      if (request === requestSequence.current) {
        running.current = null
        setBusy(false)
      }
    }
  }
  useEffect(() => {
    setChanged({})
    setDraftRows([])
    setEditing(undefined)
    setMaintenance(false)
    setCapability(undefined)
  }, [connection.id, connection.generation, schema, table])
  useEffect(() => {
    let alive = true
    if (!active || !connection.live || !detail) return
    setCapabilityBusy(true)
    void bridge.maintenance!(connection, { kind: 'capability', source: 'table', schema, table }).then(value => {
      if (alive) setCapability(value as MaintenanceCapability)
    }).catch(error => {
      if (alive) setCapability(unavailableMaintenanceCapability('table', error instanceof Error ? error.message : '无法检查维护能力。'))
    }).finally(() => { if (alive) setCapabilityBusy(false) })
    return () => { alive = false }
  }, [active, bridge, capabilityEpoch, connection, detail, schema, table])
  useEffect(() => {
    if (!active || !connection.live) {
      running.current?.abort()
      return
    }
    void loadData()
    return () => running.current?.abort()
  }, [active, connection.id, connection.generation, connection.live, schema, table])
  useEffect(() => {
    if (!active || !connection.live) return
    if (sub === 'indexes') void loadIndexes()
    else if (!detail) void loadMeta()
  }, [active, connection.id, connection.generation, connection.live, schema, table, sub])
  useEffect(() => {
    const pos = restoreScroll.current
    if (!pos || !result) return
    restoreScroll.current = null
    requestAnimationFrame(() => gridRef.current?.setScroll(pos))
  }, [result])
  const query = () => { if (guardUnsaved()) return; const next = { ...applied, filter, page: 1 }; setApplied(next); void loadData(next) }
  const clearQuery = () => { if (guardUnsaved()) return; setFilter(''); const next = { filter: '', sortField: '', sortOrder: null as 'ASC' | 'DESC' | null, page: 1 }; setApplied(next); void loadData(next) }
  const sortBy = (column: string) => {
    if (guardUnsaved()) return
    const nextOrder: 'ASC' | 'DESC' | null = applied.sortField !== column ? 'ASC' : applied.sortOrder === 'ASC' ? 'DESC' : applied.sortOrder === 'DESC' ? null : 'ASC'
    const next = { ...applied, sortField: nextOrder ? column : '', sortOrder: nextOrder, page: 1 }
    setApplied(next); void loadData(next)
  }
  const turnPage = (delta: number) => { if (guardUnsaved()) return; const next = { ...applied, page: Math.max(1, applied.page + delta) }; setApplied(next); void loadData(next) }
  const refreshData = () => { if (guardUnsaved()) return; void loadData(applied, { keepScroll: true }) }
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text) } catch { setHint('复制失败，请选中文字复制') } }
  const enable = async () => {
    setBusy(true)
    try {
      const next = !maintenance
      const value = await bridge.maintenance!(connection, { kind: 'enable', enabled: next, capabilityId: next ? capability?.id : undefined })
      setMaintenance(!!value.enabled)
      if (!value.enabled) {
        setChanged({}); setDraftRows([]); setEditing(undefined); setSelected(undefined)
        setConfirmWrite(false); saveOps.current = []
        setCapability(undefined); setCapabilityEpoch(epoch => epoch + 1)
      }
    }
    catch (e) { setError(e instanceof Error ? e.message : '无法切换维护') }
    finally { setBusy(false) }
  }
  const commitCell = (pos: { row: number; col: number }, value: string | null) => {
    if (!result) return
    setEditing(undefined)
    setChanged(old => commitCellChange(result, keys, old, pos, value))
  }
  const save = () => {
    if (!result || !maintenance) { setHint('请先开启维护模式。'); return }
    const ops: DmlOp[] = []
    for (const draft of draftRows) ops.push({ kind: 'insert', values: Object.fromEntries(Object.entries(draft.values).filter(([, value]) => value !== null && value !== '')) })
    for (const [key, values] of Object.entries(changed)) {
      const index = result.rows.findIndex((item, i) => rowKey(item, i) === key)
      if (index >= 0) ops.push({ kind: 'update', values, original: rowObject(result.columns, result.rows[index]) })
    }
    if (!ops.length) { setHint('没有待保存的修改。'); return }
    saveOps.current = ops
    setConfirmWrite(true)
  }
  const finishSave = () => {
    setConfirmWrite(false)
    setSaving(false)
    setChanged({})
    setDraftRows([])
    cache?.invalidateTable(connection, schema, table)
    void loadMeta(true)
    void loadData()
  }
  const confirmSave = async () => {
    setSaving(true)
    setHint('')
    try {
      for (const op of saveOps.current) await executeDmlOp(bridge, connection, schema, table, op)
      finishSave()
    } catch (e) {
      setSaving(false)
      setHint(e instanceof Error ? e.message : '保存失败')
    }
  }
  const removeRow = () => {
    if (!result || selected === undefined || selected.row < 0 || !capability?.canDelete) return
    saveOps.current = [{ kind: 'delete', values: {}, original: rowObject(result.columns, result.rows[selected.row]) }]
    setConfirmWrite(true)
  }
  const identityColumns = (detail?.columns || []).filter(column => /auto_increment/i.test(String(column.extra || '')) || String(column.extra) === 'YES').map(column => String(column.name))
  const addRow = () => {
    if (!result || !detail) return
    const values = Object.fromEntries((detail.columns || []).map(column => {
      const extra = String(column.extra || '')
      if (/auto_increment/i.test(extra) || extra === 'YES') return [String(column.name), '']
      if (column.defaultValue !== undefined && column.defaultValue !== null) return [String(column.name), String(column.defaultValue)]
      if (String(column.nullable) === 'YES' || String(column.nullable) === 'Y') return [String(column.name), null]
      return [String(column.name), '']
    }))
    setDraftRows(old => [...old, { id: crypto.randomUUID(), values }])
  }
  const structureText = (detail?.columns || []).map(column => {
    const bits = [String(column.name), String(column.type || '')]
    if (String(column.nullable) === 'NO' || String(column.nullable) === 'N') bits.push('NOT NULL')
    if (String(column.key || column.columnKey) === 'PRI') bits.push('PRIMARY KEY')
    if (/auto_increment/i.test(String(column.extra || ''))) bits.push('AUTO_INCREMENT')
    if (column.defaultValue !== undefined && column.defaultValue !== null) bits.push(`DEFAULT ${column.defaultValue}`)
    if (column.comment) bits.push(`COMMENT '${column.comment}'`)
    return bits.join(' ')
  }).join('\n')
  const indexes = indexRowsFromCatalog(detail)
  return <div className="db-object-tab">
    <div className="db-object-head"><strong>{table}</strong>
      <div className="db-result-tabs">
        <button className={sub === 'data' ? 'is-active' : ''} onClick={() => onSub('data')}>数据</button>
        <button className={sub === 'columns' ? 'is-active' : ''} onClick={() => onSub('columns')}>字段</button>
        {!viewOnly && <button className={sub === 'indexes' ? 'is-active' : ''} onClick={() => onSub('indexes')}>索引</button>}
      </div>
    </div>
    {error && sub !== 'data' && <p className="db-error" role="alert">{error}</p>}
    {hint && sub !== 'data' && <p className="db-info-note" role="status">{hint}</p>}
    {sub === 'data' && <>
      <form className="db-catalog-tools" onSubmit={e => { e.preventDefault(); query() }}>
        <label>Filter<input aria-label="Filter" value={filter} onChange={e => setFilter(e.target.value)} placeholder="status = 1 AND username LIKE '%test%'" /></label>
        <button className="db-primary" disabled={busy}>查询</button>
        <button type="button" disabled={busy} onClick={clearQuery}>清空</button>
      </form>
      {viewOnly && <p className="db-info-note">视图结果只允许查看。</p>}
      <QueryResultFrame
        pane={dataPane}
        onPaneChange={setDataPane}
        summary={<span>本页 {result?.rows.length || 0} 行{result ? ` · ${result.elapsedMs} ms` : ''} · 第 {applied.page} 页</span>}
        actions={<>
          <button type="button" className="db-maintenance-small" disabled={busy || applied.page <= 1} onClick={() => turnPage(-1)}>上一页</button>
          <button type="button" className="db-maintenance-small" disabled={busy || !result || result.rows.length < 100} onClick={() => turnPage(1)}>下一页</button>
          <button type="button" className="db-maintenance-small" disabled={busy} onClick={refreshData}>刷新</button>
          <MaintenanceToggle capability={capability} checking={capabilityBusy} enabled={maintenance} busy={busy}
            onToggle={() => void enable()} onReason={setHint} />
          {writable && <button type="button" className="db-maintenance-small" title={capability?.insertReason} disabled={busy || !maintenance || !capability?.canInsert} onClick={addRow}>新增</button>}
          {writable && <button type="button" className="db-maintenance-small" title={capability?.deleteReason} disabled={busy || !maintenance || selected === undefined || selected.row < 0 || !capability?.canDelete} onClick={removeRow}>删除</button>}
          {writable && <button type="button" className="db-maintenance-small" disabled={busy || saving || !maintenance || (!Object.keys(changed).length && !draftRows.length)} onClick={save}>保存</button>}
          {writable && <button type="button" className="db-maintenance-small" disabled={busy || (!Object.keys(changed).length && !draftRows.length)} onClick={discardEdits}>撤销修改</button>}
          {result && <ResultExportButtons result={result} />}
          {hint && <span className="db-muted db-query-result-hint" role="status" title={hint}>{hint}</span>}
        </>}
        message={<pre className="db-cell-detail">{error || (busy ? '正在读取数据…' : '没有消息。')}</pre>}
        empty={<p className="db-muted db-query-result-empty">{busy ? '正在读取数据…' : '没有返回行。'}</p>}
      >
        {result ? <QueryResultGrid ref={gridRef} result={result} readOnly={!writable || !maintenance || !capability?.canUpdate} allowInsert={writable && maintenance && !!capability?.canInsert} primaryKeys={keys} changed={changed} draftRows={draftRows}
          autoIncrement={identityColumns} selected={selected} editing={editing} sortField={applied.sortField} sortOrder={applied.sortOrder} onSort={sortBy} onSelect={setSelected}
          onEditStart={pos => {
            if (viewOnly) { setHint('视图结果只允许查看。'); return }
            if (!writable) { setHint('只读权限连接不支持网格维护。'); return }
            if (!maintenance) { setHint('请先开启维护模式。'); return }
            if (pos.row >= 0 && !capability?.canUpdate) { setHint(capability?.updateReason || capability?.reason || '当前结果仅支持查看。'); return }
            if (pos.row < 0 && !capability?.canInsert) { setHint(capability?.insertReason || '当前结果不允许新增。'); return }
            setEditing(pos); setSelected(pos)
          }}
          onDetailEdit={setSelected}
          onEditCommit={commitCell} onEditCancel={() => setEditing(undefined)} onRowSelect={row => setSelected({ row, col: 0 })}
          onDraftChange={(id, column, value) => { setDraftRows(old => old.map(row => row.id === id ? { ...row, values: { ...row.values, [column]: value } } : row)); setEditing(undefined) }}
          dialect={connection.dialect}
          schema={schema}
          table={table}
          columnTypes={result.columns.map(name => String((detail?.columns || []).find(column => String(column.name) === name)?.type || ''))}
          onCopyError={setHint}
          extraMenu={pos => {
            const cellValue = pos.row < 0 ? draftRows[-pos.row - 1]?.values[result.columns[pos.col]] ?? null : result.rows[pos.row]?.[pos.col] ?? null
            const canWrite = writable && maintenance && (pos.row < 0 ? capability?.canInsert : capability?.canUpdate) && !isBinaryPlaceholder(cellValue)
            return <>
              {!!keys.length && pos.row >= 0 && <button type="button" onClick={() => void copy(keys.map(key => String(result.rows[pos.row][result.columns.indexOf(key)])).join(','))}>复制主键值</button>}
              {canWrite && <button type="button" onClick={() => pos.row < 0 ? setDraftRows(old => old.map((row, i) => -(i + 1) === pos.row ? { ...row, values: { ...row.values, [result.columns[pos.col]]: null } } : row)) : commitCell(pos, null)}>设置为 NULL</button>}
              {canWrite && <button type="button" onClick={() => pos.row < 0 ? setDraftRows(old => old.map((row, i) => -(i + 1) === pos.row ? { ...row, values: { ...row.values, [result.columns[pos.col]]: '' } } : row)) : commitCell(pos, '')}>设置为空字符串</button>}
            </>
          }}
          detailColumn={selected !== undefined ? result.columns[selected.col] : undefined}
          detailValue={selected !== undefined ? selectedValue() : undefined}
          detailEditable={writable && maintenance && selected !== undefined && (selected.row < 0 ? !!capability?.canInsert : !!capability?.canUpdate) && !identityColumns.includes(result.columns[selected.col])}
          onDetailApply={text => {
            if (!selected) return
            if (selected.row < 0) {
              const id = draftRows[-selected.row - 1]?.id
              if (id) setDraftRows(old => old.map(row => row.id === id ? { ...row, values: { ...row.values, [result.columns[selected.col]]: text } } : row))
              return
            }
            commitCell(selected, text)
          }} /> : null}
      </QueryResultFrame>
    </>}
    {sub === 'columns' && <div className="db-meta-pane">
      <div className="db-catalog-tools"><button disabled={metaBusy} onClick={() => void loadMeta(true)}>刷新</button><button onClick={() => void copy(structureText)}>复制表结构</button></div>
      {metaBusy && <p className="db-info-note" role="status">正在读取字段…</p>}
      <div className="db-grid-scroll"><table className="db-grid"><thead><tr><th>字段</th><th>类型</th><th>NULL</th><th>KEY</th><th>默认值</th><th>Extra</th></tr></thead>
        <tbody>{(detail?.columns || []).map(column => <tr key={String(column.name)}>
          <td><button className="db-text-button" onContextMenu={event => { event.preventDefault(); void copy(String(column.name)) }}>{String(column.name)}</button></td>
          <td>{String(column.type || '')}</td><td>{String(column.nullable ?? '')}</td><td>{String(column.key || column.columnKey || '')}</td>
          <td>{column.defaultValue === undefined || column.defaultValue === null ? 'NULL' : String(column.defaultValue)}</td>
          <td>{String(column.extra || '')}</td>
        </tr>)}</tbody></table></div>
    </div>}
    {sub === 'indexes' && <div className="db-meta-pane">
      <div className="db-catalog-tools"><button disabled={metaBusy} onClick={() => void loadMeta(true)}>刷新</button></div>
      {metaBusy && <p className="db-info-note" role="status">正在读取索引…</p>}
      {(detail?.indexes as { status?: string; reason?: string } | undefined)?.status === 'unavailable'
        ? <p className="db-info-note">{(detail?.indexes as { reason?: string }).reason}</p>
        : <div className="db-grid-scroll"><table className="db-grid"><thead><tr><th>索引名</th><th>类型</th><th>是否唯一</th><th>字段</th></tr></thead>
          <tbody>{indexes.map(item => <tr key={item.name}><td>{item.name}</td><td>{item.type}</td><td>{item.unique}</td><td>{item.columns}</td></tr>)}</tbody></table></div>}
    </div>}
    {confirmWrite && <ConfirmWriteDialog
      busy={saving}
      error={hint}
      onCancel={() => { if (!saving) { setConfirmWrite(false); setHint('') } }}
      onConfirm={() => void confirmSave()}
    />}
  </div>
}

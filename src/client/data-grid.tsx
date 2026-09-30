import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Result } from '../shared/workbench.ts'
import { formatGridCell, formatPreview, isBinaryPlaceholder, isLongCell } from '../shared/cell-value.ts'

export { formatPreview, isBinaryPlaceholder, isLongCell, formatGridCell }

export type CellPos = { row: number; col: number }
export type CellRange = { r1: number; c1: number; r2: number; c2: number }

export type DataGridHandle = {
  getScroll(): { top: number; left: number }
  setScroll(pos: { top: number; left: number }): void
}

export type DataGridProps = {
  result: Result
  readOnly?: boolean
  allowInsert?: boolean
  primaryKeys: string[]
  changed: Record<string, Record<string, string | null>>
  draftRows: { id: string; values: Record<string, string | null> }[]
  selected?: CellPos
  editing?: CellPos
  sortField?: string
  sortOrder?: 'ASC' | 'DESC' | null
  autoIncrement?: string[]
  editableColumns?: string[]
  insertableColumns?: string[]
  onSelect(pos: CellPos): void
  onEditStart(pos: CellPos): void
  onEditCommit(pos: CellPos, value: string | null): void
  onEditCancel(): void
  onRowSelect(row: number): void
  onContext?(event: React.MouseEvent, pos: CellPos): void
  onSort?(column: string): void
  onDraftChange?(id: string, column: string, value: string | null): void
  onDetailEdit?(pos: CellPos): void
  range?: CellRange
  matches?: CellPos[]
  currentMatch?: CellPos
}

export const DataGrid = forwardRef<DataGridHandle, DataGridProps>(function DataGrid({
  result, readOnly, allowInsert, primaryKeys, changed, draftRows, selected, editing, sortField, sortOrder, autoIncrement, editableColumns, insertableColumns, onSelect, onEditStart, onEditCommit, onEditCancel, onRowSelect, onContext = () => {}, onSort, onDraftChange, onDetailEdit, range, matches, currentMatch,
}, ref) {
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const dirtyRef = useRef(false)
  const [draft, setDraft] = useState('')
  const identity = new Set(autoIncrement || [])
  const editable = editableColumns ? new Set(editableColumns) : undefined
  const insertable = insertableColumns ? new Set(insertableColumns) : editable
  const canEditExisting = !readOnly
  const canEditDraft = allowInsert ?? !readOnly
  useImperativeHandle(ref, () => ({
    getScroll: () => ({ top: rootRef.current?.scrollTop ?? 0, left: rootRef.current?.scrollLeft ?? 0 }),
    setScroll: pos => {
      if (!rootRef.current) return
      rootRef.current.scrollTop = pos.top
      rootRef.current.scrollLeft = pos.left
    },
  }))
  useEffect(() => {
    if (!editing) return
    const value = editing.row < 0 ? draftRows[-editing.row - 1]?.values[result.columns[editing.col]] : result.rows[editing.row]?.[editing.col]
    setDraft(value === null || value === undefined ? '' : value)
    dirtyRef.current = false
    queueMicrotask(() => inputRef.current?.focus({ preventScroll: true }))
  }, [editing, result, draftRows])
  const rowKey = (row: (string | null)[], index: number) => primaryKeys.length ? primaryKeys.map(key => row[result.columns.indexOf(key)]).join('\0') : `#${index}`
  const display = (row: number, col: number, value: string | null) => {
    const key = result.rows[row] ? rowKey(result.rows[row], row) : ''
    if (key && changed[key] && Object.prototype.hasOwnProperty.call(changed[key], result.columns[col])) return changed[key][result.columns[col]]
    return value
  }
  const lockedCell = (column: string, value: string | null, draft = false) => identity.has(column) || ((draft ? insertable : editable) ? !(draft ? insertable : editable)!.has(column) : false) || isBinaryPlaceholder(value)
  const startEdit = (pos: CellPos, writable: boolean, value: string | null) => {
    if (!writable) return
    if (lockedCell(result.columns[pos.col], value)) return
    if (isLongCell(value)) { onSelect(pos); onDetailEdit?.(pos); return }
    onEditStart(pos)
  }
  const commitExisting = (pos: CellPos) => {
    if (!dirtyRef.current) { onEditCancel(); return }
    onEditCommit(pos, draft)
  }
  const commitDraft = (id: string, column: string) => {
    if (!dirtyRef.current) { onEditCancel(); return }
    onDraftChange?.(id, column, draft)
    onEditCancel()
  }
  const matchSet = new Set((matches ?? []).map(hit => `${hit.row}:${hit.col}`))
  const matchClass = (row: number, col: number) => {
    if (currentMatch?.row === row && currentMatch.col === col) return 'is-cell-match is-cell-match-current'
    return matchSet.has(`${row}:${col}`) ? 'is-cell-match' : ''
  }
  const renderText = (value: string | null) => {
    if (value === null) return <em className="db-null">NULL</em>
    if (value === '') return <em className="db-null">""</em>
    return <span className="db-cell-text">{formatGridCell(value)}</span>
  }
  return <div className="db-grid-scroll" tabIndex={0} ref={rootRef}>
    <table className="db-grid db-data-grid"><thead><tr>
      <th className="db-row-number">#</th>
      {result.columns.map(column => <th key={column}><button type="button" onClick={() => onSort?.(column)}>{column}{sortField === column ? (sortOrder === 'ASC' ? ' ↑' : sortOrder === 'DESC' ? ' ↓' : '') : ''}</button></th>)}
    </tr></thead><tbody>
      {draftRows.map((row, i) => {
        const r = -(i + 1)
        return <tr key={row.id} className="db-draft-row">
          <td className="db-row-number" data-row={r}>NEW</td>
          {result.columns.map((column, c) => {
            const cellValue = row.values[column] ?? null
            const isEdit = editing?.row === r && editing?.col === c
            const locked = lockedCell(column, cellValue, true)
            return <td key={column} data-row={r} data-col={c} className={[cellClass(selected?.row === r && selected?.col === c, true, inRange(range, r, c, draftRows.length, result.rows.length)), matchClass(r, c)].filter(Boolean).join(' ')}
              onClick={() => onSelect({ row: r, col: c })}
              onDoubleClick={() => startEdit({ row: r, col: c }, canEditDraft && !locked, cellValue)}
              onContextMenu={event => { event.preventDefault(); onSelect({ row: r, col: c }); onContext(event, { row: r, col: c }) }}>
              {isEdit ? <input ref={inputRef} className="db-cell-editor" aria-label={`编辑 ${column}`} value={draft} onChange={e => { dirtyRef.current = true; setDraft(e.target.value) }}
                onBlur={() => commitDraft(row.id, column)}
                onKeyDown={e => { if (e.key === 'Enter') commitDraft(row.id, column); if (e.key === 'Escape') onEditCancel() }} />
                : renderText(cellValue)}
            </td>
          })}
        </tr>
      })}
      {result.rows.map((row, r) => <tr key={r} className={selected?.row === r ? 'is-active' : ''}>
        <td className="db-row-number" data-row={r}><button aria-label={`选中第 ${r + 1} 行`} onClick={() => onRowSelect(r)}>{r + 1}</button></td>
        {row.map((value, c) => {
          const shown = display(r, c, value)
          const dirty = shown !== value
          const isEdit = editing?.row === r && editing?.col === c
          const isSel = selected?.row === r && selected?.col === c
          const locked = lockedCell(result.columns[c], shown)
          return <td key={c} data-row={r} data-col={c} className={[cellClass(isSel, dirty, inRange(range, r, c, draftRows.length, result.rows.length)), matchClass(r, c)].filter(Boolean).join(' ')}
            onClick={() => onSelect({ row: r, col: c })}
            onDoubleClick={() => startEdit({ row: r, col: c }, canEditExisting && !locked, shown)}
            onContextMenu={event => { event.preventDefault(); onSelect({ row: r, col: c }); onContext(event, { row: r, col: c }) }}>
            {isEdit && !locked ? <input ref={inputRef} className="db-cell-editor" aria-label={`编辑 ${result.columns[c]}`} value={draft} onChange={e => { dirtyRef.current = true; setDraft(e.target.value) }}
              onBlur={() => commitExisting({ row: r, col: c })}
              onKeyDown={e => { if (e.key === 'Enter') commitExisting({ row: r, col: c }); if (e.key === 'Escape') onEditCancel() }} />
              : renderText(shown)}
          </td>
        })}
      </tr>)}
    </tbody></table>
    {!result.rows.length && !draftRows.length && <p className="db-info-note">没有返回行。</p>}
  </div>
})

function inRange(range: CellRange | undefined, row: number, col: number, draftCount: number, dataCount: number): boolean {
  if (!range) return false
  const start = visualRow(range.r1, draftCount, dataCount)
  const end = visualRow(range.r2, draftCount, dataCount)
  const here = visualRow(row, draftCount, dataCount)
  if (start == null || end == null || here == null) return false
  const c1 = Math.min(range.c1, range.c2)
  const c2 = Math.max(range.c1, range.c2)
  return here >= Math.min(start, end) && here <= Math.max(start, end) && col >= c1 && col <= c2
}

function visualRow(row: number, draftCount: number, dataCount: number): number | null {
  if (row < 0) {
    const index = -row - 1
    return index < draftCount ? index : null
  }
  return row < dataCount ? draftCount + row : null
}

function cellClass(selected: boolean, dirty: boolean, ranged: boolean): string {
  return [selected ? 'is-cell-selected' : '', dirty ? 'is-cell-changed' : '', ranged ? 'is-cell-range' : ''].filter(Boolean).join(' ')
}

import React, { useState } from 'react'
import { dbRowClass, nextDbSort, sortDbRows, type DbSortOrder } from './db-table.ts'

export type DbColumn<T> = {
  key: string
  title: React.ReactNode
  width?: number | string
  align?: 'left' | 'right' | 'center'
  sortable?: boolean
  compare?(left: unknown, right: unknown): number
  render?(row: T, index: number): React.ReactNode
}

function cellValue<T>(row: T, key: string): unknown {
  return (row as Record<string, unknown>)[key]
}

/** Read-only grid. Editing, copy and search stay on the query DataGrid. */
export function DbTable<T>({ columns, rows, rowKey, empty = '没有数据。', loading = false, sortKey, sortOrder, onSort, activeKey, onRowClick, onRowDoubleClick, numbered = false }: {
  columns: readonly DbColumn<T>[]
  rows: readonly T[]
  rowKey(row: T, index: number): string | number
  empty?: React.ReactNode
  loading?: boolean
  sortKey?: string
  sortOrder?: DbSortOrder
  onSort?(key: string): void
  activeKey?: string | number
  onRowClick?(row: T, index: number): void
  onRowDoubleClick?(row: T, index: number): void
  numbered?: boolean
}): React.ReactElement {
  const [localKey, setLocalKey] = useState<string>()
  const [localOrder, setLocalOrder] = useState<DbSortOrder>()
  const key = onSort ? sortKey : localKey
  const order = onSort ? sortOrder : localOrder
  const shown = sortDbRows(rows, key, order, cellValue, columns.find(column => column.key === key)?.compare)
  const sortBy = (column: string) => {
    if (onSort) { onSort(column); return }
    const next = nextDbSort(localKey, localOrder, column)
    setLocalKey(next.key)
    setLocalOrder(next.order)
  }
  return <div className="db-table">
    {loading && <p className="db-info-note" role="status">正在读取…</p>}
    <div className="db-grid-scroll">
      <table className="db-grid">
        <thead><tr>
          {numbered && <th className="db-row-number">#</th>}
          {columns.map(column => <th key={column.key} style={{ width: column.width, textAlign: column.align }}>
            {column.sortable
              ? <button type="button" onClick={() => sortBy(column.key)}>{column.title}{key === column.key ? (order === 'asc' ? ' ↑' : order === 'desc' ? ' ↓' : '') : ''}</button>
              : column.title}
          </th>)}
        </tr></thead>
        <tbody>
          {shown.map((row, index) => {
            const id = rowKey(row, index)
            return <tr key={id} className={dbRowClass(activeKey !== undefined && activeKey === id)}
              onClick={onRowClick ? () => onRowClick(row, index) : undefined}
              onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(row, index) : undefined}>
              {numbered && <td className="db-row-number">{index + 1}</td>}
              {columns.map(column => <td key={column.key} style={{ textAlign: column.align }}>{column.render ? column.render(row, index) : cellValue(row, column.key) == null ? '' : String(cellValue(row, column.key))}</td>)}
            </tr>
          })}
        </tbody>
      </table>
    </div>
    {!loading && !shown.length && <p className="db-info-note">{empty}</p>}
  </div>
}

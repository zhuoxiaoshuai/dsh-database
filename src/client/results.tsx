import React, { useState } from 'react'
import { exportResult, type Result } from '../shared/workbench.ts'
import { QueryResultGrid } from './query-result-grid.tsx'

export function resultSummary(result: Result, notice?: string): string {
  const hint = [notice, result.message, result.truncated ? '达到上限，仅展示部分结果' : ''].filter(Boolean).join(' · ')
  return `${result.rows.length} 行 · ${result.elapsedMs} ms${hint ? ` · ${hint}` : ''}`
}

export function downloadResult(result: Result, format: 'csv' | 'json'): void {
  const url = URL.createObjectURL(new Blob([exportResult(result, format)], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `query-loaded-${result.rows.length}.${format}`
  link.click()
  URL.revokeObjectURL(url)
}

export function ResultExportButtons({ result }: { result: Result }): React.ReactElement {
  return <>
    <button type="button" className="db-maintenance-small" onClick={() => downloadResult(result, 'csv')}>CSV</button>
    <button type="button" className="db-maintenance-small" onClick={() => downloadResult(result, 'json')}>JSON</button>
  </>
}

export function ReadonlyResultGrid({ result }: { result: Result }): React.ReactElement {
  const [selected, setSelected] = useState<{ row: number; col: number }>()
  const row = selected ? result.rows[selected.row] : undefined
  const raw = selected && row ? row[selected.col] : undefined
  return <QueryResultGrid
    result={result}
    readOnly
    allowInsert={false}
    primaryKeys={[]}
    changed={{}}
    draftRows={[]}
    selected={selected}
    onSelect={setSelected}
    onEditStart={() => {}}
    onEditCommit={() => {}}
    onEditCancel={() => {}}
    onRowSelect={rowIndex => setSelected({ row: rowIndex, col: 0 })}
    detailColumn={selected ? result.columns[selected.col] : undefined}
    detailValue={raw}
  />
}

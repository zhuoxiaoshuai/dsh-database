import { rowKey } from '../editable-grid-state.ts'
import type { Result } from '../../shared/workbench.ts'

export type SearchHit = { row: number; col: number }

export function searchCells(input: {
  result: Pick<Result, 'columns' | 'rows'>
  draftRows: { values: Record<string, string | null> }[]
  changed: Record<string, Record<string, string | null>>
  primaryKeys: string[]
  query: string
}): SearchHit[] {
  const needle = input.query.trim().toLowerCase()
  if (!needle) return []
  const hits: SearchHit[] = []
  const columns = input.result.columns
  const visit = (row: number, valueAt: (column: string, col: number) => string | null) => {
    columns.forEach((column, col) => {
      if (matches(valueAt(column, col), needle)) hits.push({ row, col })
    })
  }
  input.draftRows.forEach((draft, index) => {
    visit(-(index + 1), column => draft.values[column] ?? null)
  })
  input.result.rows.forEach((row, index) => {
    const key = rowKey(input.result as Result, input.primaryKeys, row, index)
    const overlay = input.changed[key]
    visit(index, (column, col) => overlay && Object.prototype.hasOwnProperty.call(overlay, column) ? overlay[column] : row[col] ?? null)
  })
  return hits
}

function matches(value: string | null, needle: string): boolean {
  if (value === null) return needle === 'null'
  return value.toLowerCase().includes(needle)
}

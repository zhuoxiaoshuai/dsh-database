import type { Result } from '../shared/workbench.ts'

export type CellPosition = { row: number; col: number }
export type CellChanges = Record<string, Record<string, string | null>>

export function rowObject(columns: string[], row: (string | null)[]): Record<string, string | null> {
  return Object.fromEntries(columns.map((column, index) => [column, row[index] ?? null]))
}

export function rowKey(result: Result, keys: string[], row: (string | null)[], index: number): string {
  if (keys.length) return keys.map(key => row[result.columns.indexOf(key)] ?? '').join('\0')
  return `#${index}`
}

export function commitCellChange(
  result: Result,
  keys: string[],
  changed: CellChanges,
  pos: CellPosition,
  value: string | null,
): CellChanges {
  const original = result.rows[pos.row]?.[pos.col]
  const key = rowKey(result, keys, result.rows[pos.row], pos.row)
  const column = result.columns[pos.col]
  if (value !== original) return { ...changed, [key]: { ...changed[key], [column]: value } }
  const nextRow = { ...changed[key] }
  delete nextRow[column]
  const next = { ...changed }
  if (Object.keys(nextRow).length) next[key] = nextRow
  else delete next[key]
  return next
}

export function selectedCellValue(
  result: Result,
  keys: string[],
  changed: CellChanges,
  pos: CellPosition,
  fallbackWhenNoKeys = true,
): string | null {
  const original = result.rows[pos.row]?.[pos.col] ?? null
  if (!keys.length && !fallbackWhenNoKeys) return original
  const key = rowKey(result, keys, result.rows[pos.row], pos.row)
  const column = result.columns[pos.col]
  return Object.prototype.hasOwnProperty.call(changed[key] || {}, column) ? changed[key][column] : original
}

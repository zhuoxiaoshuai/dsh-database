import { rowKey } from '../editable-grid-state.ts'
import { quoteIdentifier, type Dialect, type Result } from '../../shared/workbench.ts'

export type CopyShape = 'fields' | 'values' | 'both'
export type CopyRange = { r1: number; c1: number; r2: number; c2: number }
export type CopyGrid = { columns: string[]; rows: (string | null)[][]; types: string[] }

const NUMERIC_TYPE = /^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|number|float|double|real|bit|bool|boolean)\b/i
const BOOL_TYPE = /^(?:bool|boolean|bit)\b/i
const PLAIN_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

export function cellsInRange(
  result: Pick<Result, 'columns' | 'rows'>,
  drafts: { values: Record<string, string | null> }[],
  changed: Record<string, Record<string, string | null>>,
  primaryKeys: string[],
  range: CopyRange,
  columnTypes: string[] = [],
  mode: 'range' | 'rows' = 'range',
): CopyGrid {
  const columns = result.columns
  const lowCol = mode === 'rows' ? 0 : Math.min(range.c1, range.c2)
  const highCol = mode === 'rows' ? columns.length - 1 : Math.max(range.c1, range.c2)
  const picked = columns.map((name, index) => ({ name, index, type: columnTypes[index] || '' })).filter(column => column.index >= lowCol && column.index <= highCol)
  const rows = rowsBetween(range, drafts.length, result.rows.length)
    .filter(row => row < 0 ? drafts[-row - 1] : result.rows[row])
    .map(row => picked.map(column => cellValue(result, drafts, changed, primaryKeys, row, column.index)))
  return { columns: picked.map(column => column.name), rows, types: picked.map(column => column.type) }
}

/** Draft rows use -1, -2, … and render above data rows, so numeric order is not screen order. */
export function rowsBetween(range: CopyRange, draftCount: number, dataCount: number): number[] {
  const start = visualRow(range.r1, draftCount, dataCount)
  const end = visualRow(range.r2, draftCount, dataCount)
  if (start == null || end == null) return []
  const low = Math.min(start, end)
  const high = Math.max(start, end)
  const rows: number[] = []
  for (let index = low; index <= high; index++) rows.push(index < draftCount ? -(index + 1) : index - draftCount)
  return rows
}

function visualRow(row: number, draftCount: number, dataCount: number): number | null {
  if (row < 0) {
    const index = -row - 1
    return index < draftCount ? index : null
  }
  return row < dataCount ? draftCount + row : null
}

export function formatTsv(columns: string[], rows: (string | null)[][], shape: CopyShape): string {
  const lines: string[] = []
  if (shape !== 'values') lines.push(columns.join('\t'))
  if (shape !== 'fields') lines.push(...rows.map(row => row.map(tsvCell).join('\t')))
  return lines.join('\n')
}

export function formatCsv(columns: string[], rows: (string | null)[][], shape: CopyShape, types: string[] = []): string {
  const lines: string[] = []
  if (shape !== 'values') lines.push(columns.map(csvHeader).join(','))
  if (shape !== 'fields') lines.push(...rows.map(row => row.map((value, index) => sqlLiteral(value, types[index])).join(',')))
  return lines.join('\n')
}

export function formatInsert(dialect: Dialect, table: string, columns: string[], rows: (string | null)[][], types: string[] = [], schema = ''): string {
  const name = table.trim() || '_result'
  const target = schema.trim() ? `${quoteIdentifier(dialect, schema.trim())}.${quoteIdentifier(dialect, name)}` : quoteIdentifier(dialect, name)
  const fields = columns.map(column => quoteIdentifier(dialect, column)).join(', ')
  return rows.map(row => `INSERT INTO ${target} (${fields}) VALUES (${row.map((value, index) => sqlLiteral(value, types[index])).join(', ')});`).join('\n')
}

export async function writeClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}

export function plainCell(value: string | null): string {
  return value === null ? 'NULL' : value
}

function cellValue(
  result: Pick<Result, 'columns' | 'rows'>,
  drafts: { values: Record<string, string | null> }[],
  changed: Record<string, Record<string, string | null>>,
  primaryKeys: string[],
  row: number,
  col: number,
): string | null {
  const column = result.columns[col]
  if (!column) return null
  if (row < 0) return drafts[-row - 1]?.values[column] ?? null
  const values = result.rows[row]
  if (!values) return null
  const key = rowKey({ columns: result.columns, rows: result.rows, truncated: false, elapsedMs: 0 }, primaryKeys, values, row)
  if (Object.prototype.hasOwnProperty.call(changed[key] || {}, column)) return changed[key][column]
  return values[col] ?? null
}

function tsvCell(value: string | null): string {
  if (value === null) return 'NULL'
  if (value === '') return '""'
  return value
}

function csvHeader(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

export function sqlLiteral(value: string | null, type = ''): string {
  if (value === null) return 'NULL'
  if (NUMERIC_TYPE.test(type.trim())) {
    if (PLAIN_NUMBER.test(value)) return value
    if (BOOL_TYPE.test(type) && /^(?:true|false)$/i.test(value)) return value.toLowerCase()
  } else if (!type.trim() && PLAIN_NUMBER.test(value)) return value
  return `'${value.replaceAll("'", "''")}'`
}

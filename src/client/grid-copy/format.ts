import { rowKey } from '../editable-grid-state.ts'
import { quoteIdentifier, type Dialect, type Result } from '../../shared/workbench.ts'
import { selectionColumns, selectionRows, type GridSelection } from './selection.ts'

export type CopyShape = 'fields' | 'values' | 'both'
export type CopyGrid = { columns: string[]; rows: (string | null)[][]; types: string[] }

const NUMERIC_TYPE = /^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|number|float|double|real|bit|bool|boolean)\b/i
const BOOL_TYPE = /^(?:bool|boolean|bit)\b/i
const PLAIN_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

export function cellsInSelection(
  result: Pick<Result, 'columns' | 'rows'>,
  drafts: { values: Record<string, string | null> }[],
  changed: Record<string, Record<string, string | null>>,
  primaryKeys: string[],
  selection: GridSelection,
  columnTypes: string[] = [],
  mode: 'range' | 'rows' = 'range',
): CopyGrid {
  const columns = result.columns
  const indices = mode === 'rows' ? columns.map((_, index) => index) : selectionColumns(selection, columns.length)
  const picked = indices.map(index => ({ name: columns[index], index, type: columnTypes[index] || '' }))
  const rows = selectionRows(selection, drafts.length, result.rows.length)
    .filter(row => row < 0 ? drafts[-row - 1] : result.rows[row])
    .map(row => picked.map(column => cellValue(result, drafts, changed, primaryKeys, row, column.index)))
  return { columns: picked.map(column => column.name), rows, types: picked.map(column => column.type) }
}

export function formatTsv(columns: string[], rows: (string | null)[][], shape: CopyShape): string {
  const lines: string[] = []
  if (shape !== 'values') lines.push(columns.join('\t'))
  if (shape !== 'fields') lines.push(...rows.map(row => row.map(tsvCell).join('\t')))
  return lines.join('\n')
}

export function formatCommaList(columns: string[], rows: (string | null)[][], shape: CopyShape, types: string[] = []): string {
  const lines: string[] = []
  if (shape !== 'values') lines.push(columns.join(','))
  if (shape !== 'fields') lines.push(rows.flatMap(row => row.map((value, index) => sqlLiteral(value, types[index]))).join(','))
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

export function sqlLiteral(value: string | null, type = ''): string {
  if (value === null) return 'NULL'
  if (NUMERIC_TYPE.test(type.trim())) {
    if (PLAIN_NUMBER.test(value)) return value
    if (BOOL_TYPE.test(type) && /^(?:true|false)$/i.test(value)) return value.toLowerCase()
  } else if (!type.trim() && PLAIN_NUMBER.test(value)) return value
  return `'${value.replaceAll("'", "''")}'`
}

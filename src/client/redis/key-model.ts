import type { RedisValue } from '../../shared/redis-result.ts'
import { formatValue } from '../workspace/parts/formatted-cell-value.ts'

export type ViewKind = 'string' | 'table' | 'stream' | 'bitmap' | 'card' | 'raw'
export type StringEncoding = 'text' | 'json' | 'hex' | 'binary'
export interface KeyColumn { key: string; label: string }
export interface KeyRow { id: string; cells: Record<string, string> }
export interface KeyCard { count?: string; lines: { label: string; value: string }[] }

const TABLE_TYPES = new Set(['hash', 'list', 'set', 'zset', 'geo', 'timeseries'])
const LABELS: Record<string, string> = {
  string: 'String', hash: 'Hash', list: 'List', set: 'Set', zset: 'ZSet', json: 'Json', geo: 'Geo',
  stream: 'Stream', bitmap: 'Bit', hyperloglog: 'HyperLogLog', bloom: 'Bloom', timeseries: 'TimeSeries', none: 'none',
}

export function viewKind(keyType: string, encoding: string): ViewKind {
  if ((keyType === 'string' || keyType === 'bitmap') && encoding === 'bit') return 'bitmap'
  if (keyType === 'bitmap') return 'bitmap'
  if (keyType === 'string' || keyType === 'json') return 'string'
  if (keyType === 'stream') return 'stream'
  if (keyType === 'hyperloglog' || keyType === 'bloom') return 'card'
  if (TABLE_TYPES.has(keyType)) return 'table'
  return 'raw'
}

export function typeLabel(keyType: string): string {
  if (!keyType) return 'none'
  return LABELS[keyType] || keyType[0].toUpperCase() + keyType.slice(1)
}

export function tableColumns(keyType: string): KeyColumn[] {
  if (keyType === 'hash') return [{ key: 'field', label: 'Key' }, { key: 'value', label: 'Value' }, { key: 'ttl', label: 'TTL' }]
  if (keyType === 'list') return [{ key: 'value', label: 'Value' }]
  if (keyType === 'set') return [{ key: 'member', label: 'Member' }]
  if (keyType === 'zset') return [{ key: 'score', label: 'Score' }, { key: 'member', label: 'Member' }]
  if (keyType === 'geo') return [{ key: 'member', label: 'Member' }, { key: 'lon', label: 'Lon' }, { key: 'lat', label: 'Lat' }]
  if (keyType === 'timeseries') return [{ key: 'time', label: 'Time' }, { key: 'value', label: 'Value' }]
  if (keyType === 'stream') return [{ key: 'id', label: 'ID' }, { key: 'fields', label: 'Fields' }]
  if (keyType === 'bitmap') return [{ key: 'offset', label: 'Offset' }, { key: 'bit', label: 'Bit' }]
  return []
}

export function filterRows(rows: KeyRow[], columns: KeyColumn[], keyword: string): KeyRow[] {
  const needle = keyword.trim().toLocaleLowerCase()
  if (!needle) return rows
  return rows.filter(row => [row.id, ...columns.map(column => row.cells[column.key] ?? '')].join('\n').toLocaleLowerCase().includes(needle))
}

export function filterTime(rows: KeyRow[], from: string, to: string): KeyRow[] {
  const start = from.trim() === '' ? undefined : Number(from)
  const end = to.trim() === '' ? undefined : Number(to)
  if (start === undefined && end === undefined) return rows
  return rows.filter(row => {
    const time = Number(row.cells.time)
    if (!Number.isFinite(time)) return false
    if (start !== undefined && Number.isFinite(start) && time < start) return false
    if (end !== undefined && Number.isFinite(end) && time > end) return false
    return true
  })
}

export function sortRows(rows: KeyRow[], key: string, direction: 'asc' | 'desc'): KeyRow[] {
  const factor = direction === 'asc' ? 1 : -1
  return [...rows].sort((left, right) => {
    const a = left.cells[key] ?? (key === 'id' ? left.id : '')
    const b = right.cells[key] ?? (key === 'id' ? right.id : '')
    const an = Number(a), bn = Number(b)
    if (a !== '' && b !== '' && Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * factor
    return a.localeCompare(b) * factor
  })
}

export function rowSubmittable(keyType: string, values: Record<string, string>): boolean {
  const filled = (key: string) => (values[key] ?? '').trim() !== ''
  if (keyType === 'hash' || keyType === 'stream') return filled('field')
  if (keyType === 'list') return filled('value')
  if (keyType === 'set') return filled('member')
  if (keyType === 'zset') return filled('member') && Number.isFinite(Number(values.score))
  if (keyType === 'geo') return filled('member') && Number.isFinite(Number(values.lon)) && Number.isFinite(Number(values.lat))
  if (keyType === 'timeseries') return filled('value') && /^\d+$/.test((values.time ?? '').trim())
  if (keyType === 'bitmap') return /^\d+$/.test((values.offset ?? '').trim()) && (values.bit === '0' || values.bit === '1')
  return false
}

const COPY_COLUMN: Record<string, string> = {
  hash: 'value', list: 'value', set: 'member', zset: 'member', geo: 'member', timeseries: 'value', stream: 'fields', bitmap: 'bit',
}

export function rowCopyText(keyType: string, row: KeyRow): string {
  const key = COPY_COLUMN[keyType]
  return key ? (row.cells[key] ?? '') : Object.values(row.cells).join('\t')
}

export function rowPreview(row: KeyRow): string {
  return Object.entries(row.cells).map(([key, value]) => `${key}: ${value}`).join('\n')
}

export function presentEncoding(encoding: StringEncoding, value: string, binary?: { base64: string; length: number }): { text: string; editable: boolean; invalidJson: boolean } {
  if (encoding === 'hex') return { text: formatHex(binary ? bytesFromBase64(binary.base64) : utf8(value)), editable: false, invalidJson: false }
  if (encoding === 'binary') {
    const length = binary?.length ?? utf8(value).length
    const encoded = binary?.base64 ?? base64(value)
    return { text: `长度 ${length} 字节\n${encoded}`, editable: false, invalidJson: false }
  }
  if (encoding === 'json') {
    let invalidJson = false
    try { JSON.parse(value) } catch { invalidJson = true }
    return { text: invalidJson ? value : formatValue(value, 'json'), editable: true, invalidJson }
  }
  return { text: value, editable: true, invalidJson: false }
}

export function rejectStringSave(encoding: StringEncoding, value: string): string | undefined {
  if (encoding === 'hex' || encoding === 'binary') return '当前编码只读。'
  if (encoding === 'json') {
    try { JSON.parse(value) } catch { return 'JSON 无效，未写入。' }
  }
  return undefined
}

export function nextPage(keyType: string, cursor: string, offset: number): { cursor: string; offset: number } {
  if (keyType === 'list' || keyType === 'bitmap') return { cursor: '0', offset: offset + 100 }
  return { cursor: cursor || '0', offset: 0 }
}

export function detailRows(detail: { keyType?: unknown; rows?: unknown; value?: unknown; offset?: unknown }): KeyRow[] {
  if (Array.isArray(detail.rows)) {
    return detail.rows.flatMap(row => {
      if (!row || typeof row !== 'object' || !('id' in row)) return []
      const id = String((row as { id: unknown }).id)
      const source = 'cells' in row && (row as { cells?: unknown }).cells && typeof (row as { cells?: unknown }).cells === 'object' ? (row as { cells: Record<string, unknown> }).cells : {}
      const cells = Object.fromEntries(Object.entries(source).map(([key, value]) => [key, value == null ? '' : String(value)]))
      return id ? [{ id, cells }] : []
    })
  }
  return rowsFromEncoded(String(detail.keyType || ''), (detail.value as { result?: RedisValue } | undefined)?.result, Number(detail.offset) || 0)
}

export function detailCard(detail: { card?: unknown }): KeyCard | undefined {
  const card = detail.card
  if (!card || typeof card !== 'object') return undefined
  const count = 'count' in card && (card as { count?: unknown }).count != null ? String((card as { count: unknown }).count) : undefined
  const lines = Array.isArray((card as { lines?: unknown }).lines)
    ? (card as { lines: { label?: unknown; value?: unknown }[] }).lines.map(line => ({ label: String(line?.label ?? ''), value: String(line?.value ?? '') }))
    : []
  return { count, lines }
}

export function stringFromDetail(detail: { value?: unknown }): { text: string; binary?: { base64: string; length: number } } {
  const value = (detail.value as { result?: RedisValue } | undefined)?.result
  if (value?.type === 'binary') return { text: '', binary: { base64: String(value.value), length: value.length } }
  if (value && 'value' in value && (value.type === 'string' || value.type === 'integer')) return { text: String(value.value ?? '') }
  return { text: '' }
}

function rowsFromEncoded(keyType: string, value: RedisValue | undefined, offset: number): KeyRow[] {
  if (!value || !('value' in value) || !Array.isArray(value.value)) return []
  if (keyType === 'list' && value.type === 'array') return value.value.map((item, index) => ({ id: String(offset + index + 1), cells: { index: String(offset + index), value: redisText(item) } }))
  if (keyType === 'set' && (value.type === 'set' || value.type === 'array')) return value.value.map((item, index) => ({ id: String(index + 1), cells: { member: redisText(item) } }))
  if (keyType === 'hash' && value.type === 'map') {
    return value.value.map((pair, index) => {
      const [left, right] = Array.isArray(pair) ? pair : []
      return { id: String(index + 1), cells: { field: redisText(left), value: redisText(right), ttl: '-1' } }
    })
  }
  if (keyType === 'zset' && value.type === 'map') {
    return value.value.map((pair, index) => {
      const [left, right] = Array.isArray(pair) ? pair : []
      return { id: String(index + 1), cells: { member: redisText(left), score: redisText(right) } }
    })
  }
  return []
}

function redisText(value: RedisValue | undefined): string {
  if (!value || value.type === 'nil' || value.type === 'truncated') return ''
  if (value.type === 'binary') return `(binary, ${value.length} bytes)`
  if ('value' in value && typeof value.value === 'string') return value.value
  return ''
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}
function formatHex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ')
}
function base64(value: string): string {
  const bytes = utf8(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  if (typeof btoa === 'function') return btoa(binary)
  return Buffer.from(bytes).toString('base64')
}
function bytesFromBase64(value: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(value)
    return Uint8Array.from(binary, char => char.charCodeAt(0))
  }
  return new Uint8Array(Buffer.from(value, 'base64'))
}

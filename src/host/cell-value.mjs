const BLOB_PLACEHOLDER = /^\[BLOB \d+ bytes\]$/
const GRID_CELL_LIMIT = 80
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function formatByteValue(value) {
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  try {
    const text = utf8.decode(bytes)
    if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) return text
  } catch { /* non-text bytes use an exact hexadecimal representation */ }
  return '0x' + bytes.toString('hex')
}

export function mysqlBinaryField(field) {
  return field?.columnType === 16 || field?.columnType === 255
    || field?.characterSet === 63 && [15, 249, 250, 251, 252, 253, 254].includes(field.columnType)
}

export function formatMysqlValue(value, field) {
  if (value == null) return null
  if (field?.columnType === 16 && value instanceof Uint8Array) {
    return '0b' + Array.from(value, byte => byte.toString(2).padStart(8, '0')).join('')
  }
  return formatFetchedValue(value, 'mysql')
}

export function isBinaryCell(result, column, value) {
  return Array.isArray(result?.binaryColumns) ? result.binaryColumns.includes(column) : isBinaryPlaceholder(value)
}

export const isBinaryColumnType = type => /^(?:(?:tiny|medium|long)?blob|binary|varbinary|bit|geometry|point|linestring|polygon|multi(?:point|linestring|polygon)|geometrycollection|raw|long raw)(?:\b|\()/i.test(String(type || ''))

/**
 * @param {unknown} value
 * @param {string} dialect
 * @param {((value: string) => string) | undefined} normalizeOracle
 * @returns {string | null}
 */
export function formatFetchedValue(value, dialect, normalizeOracle) {
  if (value === null || value === undefined) return null
  if (value instanceof Uint8Array) return formatByteValue(value)
  if (typeof value === 'string') return normalizeOracle ? normalizeOracle(value) : value
  if (normalizeOracle) return normalizeOracle(String(value))
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** @param {string | null | undefined} value */
export function isBinaryPlaceholder(value) {
  return typeof value === 'string' && BLOB_PLACEHOLDER.test(value)
}

/** @param {string | null | undefined} value */
export function looksLikeJson(value) {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (!text || (text[0] !== '{' && text[0] !== '[')) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** @param {string | null | undefined} value */
export function isLongCell(value) {
  if (value == null || value === '') return false
  if (isBinaryPlaceholder(value)) return true
  return value.length > GRID_CELL_LIMIT || value.includes('\n') || looksLikeJson(value)
}

/**
 * @param {string | null} value
 * @param {number} [limit]
 */
export function formatPreview(value, limit = 100) {
  if (value === null) return 'NULL'
  if (value === '') return '""'
  return value.length > limit ? value.slice(0, limit) + '…' : value
}

/**
 * @param {string | null} value
 * @param {number} [limit]
 */
export function formatGridCell(value, limit = GRID_CELL_LIMIT) {
  if (value === null) return 'NULL'
  if (value === '') return '""'
  if (isBinaryPlaceholder(value)) return value
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > limit ? compact.slice(0, limit) + '…' : compact
}

/** @param {string | null} value */
export function formatDetailValue(value) {
  if (value === null) return 'NULL'
  if (value === '') return '""'
  if (isBinaryPlaceholder(value)) return value
  if (!looksLikeJson(value)) return value
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

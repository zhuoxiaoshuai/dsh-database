const BLOB_PLACEHOLDER = /^\[BLOB \d+ bytes\]$/
const GRID_CELL_LIMIT = 80

/**
 * @param {unknown} value
 * @param {string} dialect
 * @param {((value: string) => string) | undefined} normalizeOracle
 * @returns {string | null}
 */
export function formatFetchedValue(value, dialect, normalizeOracle) {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value)) return `[BLOB ${value.length} bytes]`
  if (value instanceof Uint8Array) return `[BLOB ${value.byteLength} bytes]`
  if (typeof value === 'string') return normalizeOracle ? normalizeOracle(value) : value
  if (normalizeOracle) return normalizeOracle(String(value))
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

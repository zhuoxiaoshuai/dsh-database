/**
 * @param {string} dialect
 * @param {{
 *   columns?: { name?: unknown, key?: unknown, columnKey?: unknown }[],
 *   indexes?: { values?: Record<string, unknown>[] },
 *   constraints?: { values?: Record<string, unknown>[] },
 *   primaryKeys?: unknown
 * } | undefined} metadata
 * @returns {string[]}
 */
export function resolvePrimaryKeys(dialect, metadata) {
  if (!metadata) return []
  if (Array.isArray(metadata.primaryKeys) && metadata.primaryKeys.every(name => typeof name === 'string') && metadata.primaryKeys.length) {
    return metadata.primaryKeys
  }
  const columns = metadata.columns || []
  const names = new Set(columns.map(column => String(column.name || '')).filter(Boolean))
  const fromColumns = columns
    .filter(column => String(column.key || column.columnKey || '') === 'PRI')
    .map(column => String(column.name || ''))
    .filter(name => names.has(name))
  const indexRows = metadata.indexes?.values || []
  const fromIndex = indexRows
    .filter(row => String(row.name || row.INDEX_NAME || row.index_name || '') === 'PRIMARY' || String(row.type || '').toLowerCase() === 'primary')
    .sort((a, b) => Number(a.SEQ_IN_INDEX || a.column_position || 0) - Number(b.SEQ_IN_INDEX || b.column_position || 0))
    .flatMap(row => Array.isArray(row.columns) ? row.columns.map(String) : [String(row.COLUMN_NAME || row.column_name || '')])
    .filter(name => names.has(name))
  const constraintRows = metadata.constraints?.values || []
  const fromConstraint = constraintRows
    .filter(row => {
      const type = String(row.type || row.CONSTRAINT_TYPE || row.constraint_type || '').replaceAll('_', ' ').toUpperCase()
      return type === 'PRIMARY' || type === 'PRIMARY KEY' || type === 'P'
    })
    .sort((a, b) => Number(a.ORDINAL_POSITION || a.ordinal_position || a.POSITION || a.position || 0)
      - Number(b.ORDINAL_POSITION || b.ordinal_position || b.POSITION || b.position || 0))
    .flatMap(row => Array.isArray(row.columns) ? row.columns.map(String) : [String(row.COLUMN_NAME || row.column_name || '')])
    .filter(name => names.has(name))
  const sources = [fromColumns, fromIndex, fromConstraint].filter(list => list.length)
  if (!sources.length) return []
  const first = sources[0]
  if (sources.some(list => list.join('\0') !== first.join('\0'))) return []
  return first
}

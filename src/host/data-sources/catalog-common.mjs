export const numberish = value => value == null || value === '' ? value : Number(value)

export function boundedName(value) {
  if (typeof value !== 'string' || !value || value.length > 128 || value.includes('\0')) throw new Error('对象名称无效。')
  return value
}

export function catalogOptions(input) {
  const offset = Number(input.offset ?? 0)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new Error('目录分页位置无效。')
  return { offset, search: typeof input.search === 'string' ? input.search.slice(0, 64) : '' }
}

export function pageRows(rows, offset, search, nameOf) {
  const needle = String(search || '').toLowerCase()
  const filtered = needle ? rows.filter(row => nameOf(row).toLowerCase().includes(needle)) : rows
  const window = filtered.slice(offset, offset + 101)
  return { items: window.slice(0, 100), more: window.length > 100 }
}

export function checkCatalogAbort(signal) {
  if (signal?.aborted) throw Object.assign(new Error('读取已取消。'), { cancelled: true })
}

export function visibleCatalogSql(statement) {
  if (!statement?.sql) return
  return statement.params?.length ? `${statement.sql}\n-- params: ${JSON.stringify(statement.params)}` : statement.sql
}

export function normalizeIndexes(rows) {
  const grouped = new Map()
  for (const row of rows || []) {
    const name = String(row.Key_name ?? row.INDEX_NAME ?? row.index_name ?? '')
    if (!name) continue
    const item = grouped.get(name) || {
      name,
      unique: String(row.Non_unique ?? row.NON_UNIQUE ?? row.non_unique ?? '') === '0'
        || /UNIQUE/i.test(String(row.uniqueness ?? '')),
      type: String(row.Index_type ?? row.INDEX_TYPE ?? row.index_type ?? 'INDEX'),
      columns: [],
    }
    item.columns.push({
      name: String(row.Column_name ?? row.COLUMN_NAME ?? row.column_name ?? ''),
      position: Number(row.Seq_in_index ?? row.SEQ_IN_INDEX ?? row.seq_in_index ?? row.column_position ?? 0),
    })
    grouped.set(name, item)
  }
  return [...grouped.values()].map(item => ({
    ...item,
    type: item.name === 'PRIMARY' ? 'PRIMARY' : item.unique ? 'UNIQUE' : item.type,
    columns: item.columns.sort((a, b) => a.position - b.position).map(column => column.name).filter(Boolean),
  }))
}

const constraintType = value => ({
  P: 'primary', 'PRIMARY KEY': 'primary', U: 'unique', UNIQUE: 'unique',
  'UNIQUE KEY': 'unique', R: 'foreign', 'FOREIGN KEY': 'foreign', C: 'check', CHECK: 'check',
}[String(value || '').replaceAll('_', ' ').toUpperCase()])

export function normalizeConstraints(rows) {
  const grouped = new Map()
  for (const row of rows || []) {
    const name = String(row.CONSTRAINT_NAME ?? row.constraint_name ?? '')
    const type = constraintType(row.CONSTRAINT_TYPE ?? row.constraint_type)
    if (!name || !type) continue
    const item = grouped.get(name) || {
      name, type, columns: [], status: String(row.STATUS ?? row.status ?? ''),
      referencedOwner: row.R_OWNER ?? row.r_owner,
      referencedConstraint: row.R_CONSTRAINT_NAME ?? row.r_constraint_name,
      deleteRule: row.DELETE_RULE ?? row.delete_rule,
      expression: row.SEARCH_CONDITION_VC ?? row.search_condition_vc,
    }
    const column = String(row.COLUMN_NAME ?? row.column_name ?? '')
    if (column) item.columns.push({ name: column, position: Number(row.ORDINAL_POSITION ?? row.ordinal_position ?? row.POSITION ?? row.position ?? 0) })
    grouped.set(name, item)
  }
  return [...grouped.values()].map(item => ({
    ...item,
    columns: item.columns.sort((a, b) => a.position - b.position).map(column => column.name),
  }))
}

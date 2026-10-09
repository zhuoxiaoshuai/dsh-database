import { randomUUID } from 'node:crypto'
import { resolvePrimaryKeys } from './primary-keys.mjs'
import { getDataSource } from './data-sources/sql-registry.mjs'
import { isBinaryColumnType } from './cell-value.mjs'

const systemSchemas = new Set(['mysql', 'information_schema', 'performance_schema', 'sys', 'sysaux', 'system', 'xdb', 'outln'])

const unavailable = (source, reason) => ({
  source, canEnable: false, canInsert: false, canUpdate: false, canDelete: false,
  reason, insertReason: reason, updateReason: reason, deleteReason: reason,
  primaryKeys: [], resultPrimaryKeys: [], identityColumns: [], columns: [],
})

function withoutRegions(sql) {
  let out = '', i = 0
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i)
      out += ' '.repeat((end < 0 ? sql.length : end) - i)
      i = end < 0 ? sql.length : end
      continue
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2)
      const stop = end < 0 ? sql.length : end + 2
      out += ' '.repeat(stop - i); i = stop; continue
    }
    const quote = sql[i]
    if (quote === "'" || quote === '"' || quote === '`') {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) { j += 2; continue }
          j += 1; break
        }
        if (sql[j] === '\\' && quote === "'") j += 2
        else j += 1
      }
      out += quote === "'" ? ' '.repeat(j - i) : sql.slice(i, j)
      i = j; continue
    }
    out += sql[i++]
  }
  return out
}

function topLevelIndex(sql, word, start = 0) {
  let depth = 0
  const upper = sql.toUpperCase()
  for (let i = start; i <= sql.length - word.length; i++) {
    if (sql[i] === '(') { depth++; continue }
    if (sql[i] === ')') { depth--; continue }
    if (depth !== 0 || upper.slice(i, i + word.length) !== word) continue
    const before = i ? upper[i - 1] : ' '
    const after = upper[i + word.length] || ' '
    if (!/[A-Z0-9_$#]/.test(before) && !/[A-Z0-9_$#]/.test(after)) return i
  }
  return -1
}

function splitTopLevel(text) {
  const values = []
  let depth = 0, start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') depth--
    else if (text[i] === ',' && depth === 0) { values.push(text.slice(start, i).trim()); start = i + 1 }
  }
  values.push(text.slice(start).trim())
  return values.filter(Boolean)
}

function maskNested(sql) {
  let out = '', depth = 0
  for (const ch of sql) {
    if (ch === '(') { depth++; out += ' '; continue }
    if (ch === ')') { depth = Math.max(0, depth - 1); out += ' '; continue }
    out += depth ? ' ' : ch
  }
  return out
}

function topLevelCall(sql, names) {
  const upper = sql.toUpperCase()
  let depth = 0
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === '(') { depth++; continue }
    if (sql[i] === ')') { depth = Math.max(0, depth - 1); continue }
    if (depth !== 0) continue
    for (const name of names) {
      if (!upper.startsWith(name, i)) continue
      if (i && /[A-Z0-9_$#]/.test(upper[i - 1])) continue
      let j = i + name.length
      while (j < sql.length && /\s/.test(sql[j])) j++
      if (sql[j] === '(') return true
    }
  }
  return false
}

const ident = String.raw`(?:"(?:[^"]|"")*"|` + '`(?:[^`]|``)*`' + String.raw`|[A-Za-z_$#][\w$#]*)`
const unquote = value => {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('`') && value.endsWith('`'))) return value.slice(1, -1).replaceAll(value[0] + value[0], value[0])
  return value
}

export async function analyzeQueryMaintenance(dialect, sql, resultColumns = []) {
  const cleaned = withoutRegions(String(sql || '')).trim().replace(/;\s*$/, '')
  if (!cleaned) return unavailable('query', '没有可分析的查询。')
  if (/^WITH\b/i.test(cleaned)) return unavailable('query', 'CTE 查询结果统一只读。')
  if (!/^SELECT\b/i.test(cleaned)) return unavailable('query', '只有单条 SELECT 结果可以维护。')
  const outer = maskNested(cleaned)
  if (/\b(?:UNION|INTERSECT|MINUS)\b/i.test(outer)) return unavailable('query', '集合查询结果来源不唯一。')
  if (/\bJOIN\b/i.test(outer)) return unavailable('query', 'JOIN 结果来自多张表。')
  if (/\bDISTINCT\b/i.test(outer)) return unavailable('query', 'DISTINCT 结果可能合并多条记录。')
  if (/\bGROUP\s+BY\b|\bHAVING\b/i.test(outer) || topLevelCall(cleaned, ['AVG', 'COUNT', 'GROUP_CONCAT', 'LISTAGG', 'MAX', 'MIN', 'STDDEV', 'SUM', 'VARIANCE'])) {
    return unavailable('query', '聚合结果不是原始记录。')
  }
  if (topLevelCall(cleaned, ['OVER'])) return unavailable('query', '窗口函数结果不可维护。')

  // Parse once with the authoritative dialect parser. Text extraction below deliberately
  // accepts only a tiny direct-column subset after syntax validity is established.
  try {
    if (!await getDataSource(dialect).policy.validateMaintenanceSelect(sql)) return unavailable('query', '只能维护单条有效 SELECT 结果。')
  } catch {
    return unavailable('query', '只能维护单条有效 SELECT 结果。')
  }

  const fromAt = topLevelIndex(cleaned, 'FROM', 6)
  if (fromAt < 0) return unavailable('query', '无法确定结果来源表。')
  const tailWords = ['WHERE', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'FOR']
    .map(word => topLevelIndex(cleaned, word, fromAt + 4)).filter(index => index >= 0)
  const fromEnd = tailWords.length ? Math.min(...tailWords) : cleaned.length
  const fromText = cleaned.slice(fromAt + 4, fromEnd).trim()
  if (fromText.includes(',')) return unavailable('query', '查询涉及多个基础表。')
  if (/^\(/.test(fromText) || /\bSELECT\b/i.test(fromText)) return unavailable('query', '派生表结果统一只读。')
  const tableMatch = fromText.match(new RegExp(`^(${ident})(?:\\s*\\.\\s*(${ident}))?(?:\\s+(?:AS\\s+)?(${ident}))?$`, 'i'))
  if (!tableMatch) return unavailable('query', '来源不是可确认的单一基础表。')
  const schema = tableMatch[2] ? unquote(tableMatch[1]) : undefined
  const table = unquote(tableMatch[2] || tableMatch[1])
  const alias = tableMatch[3] ? unquote(tableMatch[3]) : undefined
  if (schema && systemSchemas.has(schema.toLowerCase())) return unavailable('query', '系统表统一只读。')

  const projections = splitTopLevel(cleaned.slice(6, fromAt))
  const columns = []
  let hasExpression = false
  for (let index = 0; index < projections.length; index++) {
    const part = projections[index]
    const star = part.match(new RegExp(`^(?:(${ident})\\s*\\.\\s*)?\\*$`, 'i'))
    if (star) {
      if (star[1] && ![alias, table].filter(Boolean).some(name => name.toLowerCase() === unquote(star[1]).toLowerCase())) {
        return unavailable('query', '通配符不属于目标基础表。')
      }
      for (const resultColumn of resultColumns) columns.push({ resultColumn, sourceColumn: resultColumn, editable: true })
      continue
    }
    const direct = part.match(new RegExp(`^(?:(${ident})\\s*\\.\\s*)?(${ident})(?:\\s+(?:AS\\s+)?(${ident}))?$`, 'i'))
    const resultColumn = resultColumns[index] || (direct ? unquote(direct[3] || direct[2]) : `#${index + 1}`)
    if (!direct || (direct[1] && ![alias, table].filter(Boolean).some(name => name.toLowerCase() === unquote(direct[1]).toLowerCase()))) {
      hasExpression = true
      columns.push({ resultColumn, editable: false, reason: '计算表达式不可编辑。' })
      continue
    }
    columns.push({ resultColumn, sourceColumn: unquote(direct[2]), editable: true })
  }
  const counts = new Map()
  for (const column of columns) counts.set(column.resultColumn.toLowerCase(), (counts.get(column.resultColumn.toLowerCase()) || 0) + 1)
  for (const column of columns) if (counts.get(column.resultColumn.toLowerCase()) > 1) {
    column.editable = false
    column.reason = '结果列名重复，无法安全映射。'
  }
  return { source: 'query', schema, table, columns, hasExpression }
}

export function finalizeMaintenanceCapability({
  source, schema, table, dialect, metadata, shape, privileges = { insert: true, update: true, delete: true },
}) {
  const primaryKeys = resolvePrimaryKeys(dialect, metadata || {})
  const rawColumns = metadata?.columns || []
  const identityColumns = rawColumns.filter(column => /auto_increment|generated|virtual/i.test(String(column.extra || '')) || String(column.extra) === 'YES').map(column => String(column.name))
  const known = new Map(rawColumns.map(column => [String(column.name).toLowerCase(), String(column.name)]))
  const columns = (shape?.columns || rawColumns.map(column => ({ resultColumn: String(column.name), sourceColumn: String(column.name), editable: true }))).map(column => {
    const sourceColumn = column.sourceColumn ? known.get(column.sourceColumn.toLowerCase()) : undefined
    if (!sourceColumn) return { ...column, editable: false, reason: column.reason || '不是目标表的真实字段。' }
    if (isBinaryColumnType(rawColumns.find(item => String(item.name).toLowerCase() === sourceColumn.toLowerCase())?.type)) return { ...column, sourceColumn, editable: false, reason: '二进制字段只支持查看。' }
    if (primaryKeys.some(key => key.toLowerCase() === sourceColumn.toLowerCase())) return { ...column, sourceColumn, editable: false, reason: '主键第一版不允许直接修改。' }
    if (identityColumns.some(key => key.toLowerCase() === sourceColumn.toLowerCase())) return { ...column, sourceColumn, editable: false, reason: '自增或生成列不可修改。' }
    return { ...column, sourceColumn }
  })
  const resultPrimaryKeys = primaryKeys.map(key => columns.find(column => column.sourceColumn?.toLowerCase() === key.toLowerCase())?.resultColumn).filter(Boolean)
  const completeKey = primaryKeys.length > 0 && resultPrimaryKeys.length === primaryKeys.length
  const directInsert = source === 'table' || !shape?.hasExpression
  const canUpdate = !!privileges.update && completeKey && columns.some(column => column.editable)
  // Maintenance is an all-or-nothing editing mode. If an existing row cannot be
  // safely updated, do not expose insert-only maintenance with incomplete fields.
  const canInsert = canUpdate && !!privileges.insert && directInsert
  const canDelete = canUpdate && !!privileges.delete && completeKey
  const reason = canUpdate ? '' : !primaryKeys.length
    ? '目标表没有主键，无法安全修改记录。'
    : !completeKey ? '结果未包含完整主键，无法定位真实记录。'
      : !columns.some(column => column.editable) ? '结果中没有可编辑的真实字段。'
        : '账号没有目标表的 UPDATE 权限。'
  return {
    id: randomUUID(), source, schema, table, canEnable: canUpdate,
    canInsert, canUpdate, canDelete, reason,
    insertReason: canInsert ? undefined : !canUpdate ? reason : shape?.hasExpression ? '包含计算列的查询结果不开放新增。' : '账号没有 INSERT 权限。',
    updateReason: canUpdate ? undefined : !completeKey ? '结果未包含完整主键。' : '没有可编辑真实字段或 UPDATE 权限。',
    deleteReason: canDelete ? undefined : !completeKey ? '结果未包含完整主键。' : '账号没有 DELETE 权限。',
    primaryKeys, resultPrimaryKeys, identityColumns, columns,
  }
}

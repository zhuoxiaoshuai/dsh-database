import { resolvePrimaryKeys } from './primary-keys.mjs'
import { quoteIdentifier } from './query-policy.mjs'
import { getSqlDialect } from './dialects/registry.mjs'
const generated = extra => /generated|virtual/i.test(extra || '')
const typeOf = column => String(column.type || '')
const comparable = column => !generated(column.extra) && /^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|number|float|double|real|bit|bool|boolean|year|time|char|varchar|varchar2|nchar|nvarchar2|date|datetime|timestamp|enum|set)(?:\b|\()/i.test(typeOf(column))
const assignable = column => !generated(column.extra) && /^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|number|float|double|real|bit|bool|boolean|year|time|char|varchar|varchar2|nchar|nvarchar2|nclob|clob|date|datetime|timestamp|enum|set|json|text|tinytext|mediumtext|longtext|blob|tinyblob|mediumblob|longblob|raw)(?:\b|\()/i.test(typeOf(column))
export function createDmlPlan(dialect, schema, table, operation, metadata) {
  const sqlDialect = getSqlDialect(dialect)
  const columns = metadata.columns || []
  if (!columns.length) throw new Error('缺少表结构，暂不开放记录维护。')
  if (metadata.truncated) throw new Error('结构已截断，不开放记录维护。')
  const quote = value => quoteIdentifier(dialect, value)
  const byName = new Map(columns.map(c => [c.name, c]))
  const names = new Set(columns.map(c => c.name)), params = []
  const bind = (value, column) => {
    if (!(value === null || typeof value === 'string') || (typeof value === 'string' && value.length > 16384)) throw new Error('字段值须为原始字符串或 NULL。')
    if (value === null) {
      params.push(null)
      return sqlDialect.bindPlaceholder(params.length)
    }
    const transformed = sqlDialect.bindValue(column, value, sqlDialect.bindPlaceholder(params.length + 1))
    params.push(transformed.value)
    return transformed.expression
  }
  const compare = (column, value) => {
    if (value === null) return `${quote(column.name)} IS NULL`
    const placeholder = bind(value, column)
    return sqlDialect.equality(quote(column.name), placeholder, column)
  }
  const target = `${quote(schema)}.${quote(table)}`
  const primary = resolvePrimaryKeys(dialect, metadata)
  if (primary.some(name => !names.has(name))) throw new Error('缺少可靠主键，暂不支持受控记录维护。')
  if (!['insert', 'update', 'delete'].includes(operation?.kind)) throw new Error('记录操作无效。')
  if (operation.kind !== 'insert' && !primary.length) throw new Error('缺少可靠主键，暂不支持受控记录维护。')
  const values = operation.values || {}
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some(k => !names.has(k))) throw new Error('写入字段不存在。')
  let sql
  if (operation.kind === 'insert') {
    const keys = Object.keys(values)
    if (!keys.length) throw new Error('请至少填写一个字段。')
    for (const key of keys) {
      const column = byName.get(key)
      if (!column || !assignable(column)) throw new Error('此表包含尚未验证的字段类型或生成列，暂不开放记录维护。')
    }
    sql = `INSERT INTO ${target} (${keys.map(quote).join(', ')}) VALUES (${keys.map(k => bind(values[k], byName.get(k))).join(', ')})`
  } else {
    const original = operation.original
    if (!original || typeof original !== 'object' || primary.some(k => !Object.hasOwn(original, k) || original[k] === null)) throw new Error('缺少可定位该行的主键，请刷新。')
    let set = ''
    const extra = []
    if (operation.kind === 'update') {
      const keys = Object.keys(values)
      if (!keys.length) throw new Error('没有待保存的字段。')
      if (keys.some(k => primary.includes(k))) throw new Error('一期不直接修改主键值，请通过新增和删除记录处理。')
      for (const key of keys) {
        const column = byName.get(key)
        if (!column || !assignable(column)) throw new Error('此表包含尚未验证的字段类型或生成列，暂不开放记录维护。')
        if (comparable(column) && Object.hasOwn(original, key)) extra.push(column)
      }
      set = keys.map(k => `${quote(k)}=${bind(values[k], byName.get(k))}`).join(', ')
    } else {
      for (const column of columns) {
        if (!comparable(column)) continue
        // Partial query projections may delete by a complete primary key. Preserve
        // optimistic comparisons for every direct source column the result actually carried.
        if (Object.hasOwn(original, column.name) && !primary.includes(column.name)) extra.push(column)
      }
    }
    const whereCols = [...primary.map(name => byName.get(name)), ...extra.filter(column => !primary.includes(column.name))]
    const where = whereCols.map(column => compare(column, original[column.name])).join(' AND ')
    sql = operation.kind === 'update' ? `UPDATE ${target} SET ${set} WHERE ${where}` : `DELETE FROM ${target} WHERE ${where}`
  }
  if (Buffer.byteLength(JSON.stringify(params)) > 16384) throw new Error('变更内容超过 16 KiB，请减少本次修改。')
  return { kind: 'dml', operation: operation.kind, schema, table, sql, params, maxRows: 100, expectedRows: 1 }
}

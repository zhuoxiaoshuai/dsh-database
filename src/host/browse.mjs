import { quoteIdentifier } from './query-policy.mjs'
import { DEFAULT_QUERY_PAGE_SIZE } from './shared/limits.mjs'
import { getSqlDialect } from './dialects/registry.mjs'
import { resolvePrimaryKeys } from './primary-keys.mjs'
export function buildBrowse(dialect, input, metadata) {
  const sqlDialect = getSqlDialect(dialect)
  const quote = value => quoteIdentifier(dialect, value)
  const page = input.page ?? 0
  if (!Number.isInteger(page) || page < 0 || page > 10000 || !metadata.columns?.length || metadata.truncated) throw new Error('目标结构或分页无效。')
  const byName = new Map(metadata.columns.map(c => [c.name, c]))
  const names = new Set(metadata.columns.map(c => c.name)), params = [], predicates = []
  if (!Array.isArray(input.filters ?? []) || (input.filters?.length ?? 0) > 8) throw new Error('最多支持 8 个筛选条件。')
  for (const filter of input.filters || []) {
    if (!names.has(filter.column)) throw new Error('筛选字段不存在。')
    if (filter.operator === 'null') { predicates.push(quote(filter.column) + ' IS NULL'); continue }
    const operators = { eq: '=', ne: '<>', gt: '>', lt: '<', gte: '>=', lte: '<=', contains: 'LIKE' }
    if (!Object.hasOwn(operators, filter.operator) || typeof filter.value !== 'string' || filter.value.length > 4096) throw new Error('筛选条件无效。')
    const column = byName.get(filter.column)
    const value = filter.operator === 'contains' ? '%' + filter.value.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_') + '%' : filter.value
    const transformed = sqlDialect.filterBind(column, value, sqlDialect.bindPlaceholder(params.length + 1), filter.operator)
    params.push(transformed.value)
    predicates.push(`${quote(filter.column)} ${operators[filter.operator]} ${transformed.expression}${filter.operator === 'contains' ? " ESCAPE '!'" : ''}`)
  }
  const primary = resolvePrimaryKeys(dialect, metadata)
  const order = []
  if (input.sort?.column) { if (!names.has(input.sort.column) || !['ASC', 'DESC'].includes(input.sort.direction)) throw new Error('排序条件无效。'); order.push(`${quote(input.sort.column)} ${input.sort.direction}`) }
  for (const column of primary) if (column !== input.sort?.column) order.push(quote(column) + ' ASC')
  const fetchSize = DEFAULT_QUERY_PAGE_SIZE + 1
  const offset = page * DEFAULT_QUERY_PAGE_SIZE
  const sql = `SELECT ${[...names].map(quote).join(', ')} FROM ${quote(input.schema)}.${quote(input.table)}${predicates.length ? ' WHERE ' + predicates.join(' AND ') : ''}${order.length ? ' ORDER BY ' + order.join(', ') : ''} ${sqlDialect.limitClause(fetchSize, offset)}`
  return { sql, params, schema: input.schema, limit: DEFAULT_QUERY_PAGE_SIZE, warning: primary.length ? '使用主键补齐排序；并发增删仍可能使不同页发生变化。' : '未发现可靠唯一键，分页可能重复或遗漏；建议显式选择稳定排序。' }
}

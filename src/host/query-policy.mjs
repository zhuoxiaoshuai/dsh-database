import { getDataSource } from './data-sources/sql-registry.mjs'
import { aliasesOf, guard, splitStatements as splitCommonStatements } from './data-sources/sql-policy-common.mjs'

export function splitStatements(sql, dialect) {
  return dialect ? getDataSource(dialect).policy.splitStatements(sql) : splitCommonStatements(sql)
}

export function quoteIdentifier(dialect, value, options = {}) {
  const {
    maxLength,
    maxBytes,
    rejectNul = false,
    rejectControls = false,
    requireNonWhitespace = false,
    errorMessage = '对象名称无效。',
  } = options
  if (
    (maxLength !== undefined && (typeof value !== 'string' || !value || value.length > maxLength))
    || (maxBytes !== undefined && (typeof value !== 'string' || Buffer.byteLength(value) > maxBytes))
    || (rejectNul && (typeof value !== 'string' || value.includes('\0')))
    || (rejectControls && (typeof value !== 'string' || /[\0-\x1f]/.test(value)))
    || (requireNonWhitespace && (typeof value !== 'string' || !value.trim()))
  ) throw new Error(errorMessage)
  return getDataSource(dialect).driver.sql.quote(value)
}

export async function authorizeStatement(dialect, sql, schema) {
  const policy = getDataSource(dialect).policy
  guard(sql, schema)
  const parts = splitStatements(sql, dialect)
  if (parts.length > 1) {
    const authorized = []
    for (const part of parts) authorized.push(await authorizeStatement(dialect, part, schema))
    const writes = authorized.filter(item => item.kind === 'write')
    const tables = [...new Set(authorized.flatMap(item => item.tables || []))]
    const references = authorized.flatMap(item => item.references || [])
    const aliases = [...new Set(authorized.flatMap(item => aliasesOf(item.aliases)))]
    const sqlText = sql.trim().replace(/;\s*$/, '')
    if (writes.length) {
      return { kind: 'write', tables, targets: writes.flatMap(item => item.targets || []), references, aliases, sql: sqlText }
    }
    if (authorized.every(item => item.kind === 'explain')) {
      return { kind: 'explain', tables, references, aliases, sql: sqlText, targetSql: authorized[0].targetSql }
    }
    if (authorized.every(item => item.kind === 'show')) {
      return { kind: 'show', tables, references, aliases, sql: sqlText }
    }
    return { kind: 'select', tables, references, aliases, sql: sqlText }
  }
  const tables = new Set(), ctes = new Set(), references = [], aliases = new Set()
  const leading = sql.trim().replace(/^--[\s\S]*?\n/, '').trim()
  // EXPLAIN preserves its intent; only a fully authorized SELECT may run.
  if (/^EXPLAIN\s/i.test(leading)) {
    const innerSql = policy.extractExplainSql(sql)
    if (innerSql) {
      const inner = await authorizeStatement(dialect, innerSql, schema)
      if (inner.kind === 'select') return { kind: 'explain', tables: inner.tables, references, aliases, sql: sql.trim().replace(/;\s*$/, ''), targetSql: innerSql }
      throw new Error('暂只支持 EXPLAIN SELECT；未执行任何修改。')
    }
  }
  return policy.authorize(sql, schema)
}

// 兼容遗留：browse / AI 路径仅读，强制 SELECT。
export async function authorizeSelect(dialect, sql, schema) {
  const result = await authorizeStatement(dialect, sql, schema)
  if (result.kind !== 'select') throw new Error('只允许单条 SELECT。')
  return result
}

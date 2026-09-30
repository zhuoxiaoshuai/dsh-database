import { clientWorkspaceDescriptor } from './data-sources/registry.ts'

// 去除前导注释（-- 行注释 / # MySQL 行注释 / /* 块注释 */），用于语句类型预判。
// 未闭合的块注释会原样返回，由 host 侧解析器报语法错误。
export function isExplainSql(text: string): boolean {
  return /^explain\b/i.test(stripLeadingComments(text))
}

/** 包装为方言 EXPLAIN；已是 EXPLAIN 则原样返回（去掉末尾分号）。 */
export function wrapExplainSql(dialect: 'mysql' | 'oracle' | 'redis' | 'kafka', sql: string): string {
  const source = clientWorkspaceDescriptor(dialect)
  if (source.family !== 'sql') throw new Error('此数据源不支持 SQL EXPLAIN。')
  const trimmed = sql.trim().replace(/;\s*$/, '')
  if (isExplainSql(trimmed)) return trimmed
  return `${source.explainPrefix} ${trimmed}`
}

/** 去掉最外层 EXPLAIN 前缀，用于判断内层语句类型。 */
export function unwrapExplainSql(sql: string): string {
  let rest = stripLeadingComments(sql.trim().replace(/;\s*$/, ''))
  const plan = rest.match(/^explain\s+plan\s+for\s+([\s\S]+)$/i)
  if (plan) return plan[1].trim()
  const plain = rest.match(/^explain\s+(?:format\s*=\s*\w+\s+)?([\s\S]+)$/i)
  if (plain) return plain[1].trim()
  return rest
}

export function stripLeadingComments(text: string): string {
  let rest = text
  for (;;) {
    const next = rest.replace(/^(?:\s+|--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/, '')
    if (next === rest) return next
    rest = next
  }
}

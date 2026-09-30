import { classify, riskOf, unique, type TemplateRisk } from './data-sources/template-common.ts'
import { parseTemplate as parseMysql } from './data-sources/mysql/template-parser.ts'
import { parseTemplate as parseOracle } from './data-sources/oracle/template-parser.ts'
export type { TemplateRisk } from './data-sources/template-common.ts'

export type DialectKind = 'mysql' | 'oracle'

export type TemplateFeatures = {
  operation: string
  tables: string[]
  columns: string[]
  conditionColumns: string[]
  joins: string[]
  aggregates: string[]
  groupBy: string[]
  orderBy: string[]
  risk: TemplateRisk
  parseOk: boolean
}

export type ParsedTemplateFeatures = Omit<TemplateFeatures, 'risk' | 'parseOk'>

export type NormalizedTemplate = {
  originalSql: string
  normalizedSql: string
  fingerprint: string
  features: TemplateFeatures
  suggestedTitle: string
  suggestedTags: string[]
  suggestedSummary: string
}

const SQL_MAX = 32768

function clip(sql: string): string {
  return sql.trim().slice(0, SQL_MAX)
}

function stripLiterals(sql: string): string {
  return sql
    .replace(/'(?:''|[^'\\]|\\.)*'/g, ':s')
    .replace(/N'(?:''|[^'\\]|\\.)*'/gi, ':s')
    .replace(/\b0x[0-9a-f]+\b/gi, ':x')
    .replace(/\b\d+(\.\d+)?\b/g, ':n')
    .replace(/\s+/g, ' ')
    .trim()
}

function fingerprintOf(features: TemplateFeatures, normalizedSql: string): string {
  if (!features.parseOk) return `raw|${normalizedSql.toLowerCase()}`
  return [
    features.operation,
    `t:${features.tables.join(',')}`,
    `c:${features.columns.join(',')}`,
    `w:${features.conditionColumns.join(',')}`,
    `j:${features.joins.join(',')}`,
    `g:${features.groupBy.join(',')}`,
    `o:${features.orderBy.join(',')}`,
    `a:${features.aggregates.join(',')}`,
  ].join('|')
}

const templateParsers: Record<DialectKind, (sql: string) => Promise<ParsedTemplateFeatures | undefined>> = {
  mysql: parseMysql,
  oracle: parseOracle,
}

function finishDraft(originalSql: string, dialect: DialectKind, parsed: TemplateFeatures | undefined, attempted: boolean): NormalizedTemplate {
  if (!originalSql) throw new Error('请输入要保存的 SQL。')
  const operation = parsed?.operation || classify(originalSql)
  const features = parsed || {
    operation,
    tables: [],
    columns: [],
    conditionColumns: [],
    joins: [],
    aggregates: [],
    groupBy: [],
    orderBy: [],
    risk: riskOf(operation),
    parseOk: false,
  }
  const normalizedSql = stripLiterals(originalSql).replace(/\b(select|from|where|and|or|join|left|right|inner|outer|group|by|order|having|insert|into|update|set|delete|values|create|alter|drop|table)\b/gi, token => token.toUpperCase())
  const fingerprint = fingerprintOf(features, normalizedSql)
  const tables = features.tables.length ? features.tables.join(', ') : (attempted ? '未解析对象' : '')
  const suggestedTitle = `${features.operation === 'unknown' ? 'SQL' : features.operation.toUpperCase()}${tables ? ` ${tables}` : ''}`.slice(0, 80)
  const suggestedTags = unique([dialect, features.operation, ...features.tables, features.risk]).slice(0, 12)
  const suggestedSummary = features.parseOk
    ? `${features.operation.toUpperCase()}，涉及 ${features.tables.join(', ') || '未列出表'}；条件字段 ${features.conditionColumns.join(', ') || '无'}。`
    : attempted
      ? '未能完整解析语句结构，仅按原文保存，不会自动合并到已有模板。'
      : ''
  return { originalSql, normalizedSql, fingerprint, features, suggestedTitle, suggestedTags, suggestedSummary }
}

/** Sync draft used to persist immediately; AST parse can fill features later. */
export function draftSqlExperience(sql: string, dialect: DialectKind): NormalizedTemplate {
  return finishDraft(clip(sql), dialect, undefined, false)
}

export async function normalizeSqlExperience(sql: string, dialect: DialectKind): Promise<NormalizedTemplate> {
  const originalSql = clip(sql)
  if (!originalSql) throw new Error('请输入要保存的 SQL。')
  const raw = await templateParsers[dialect](originalSql)
  const parsed: TemplateFeatures | undefined = raw ? { ...raw, risk: riskOf(raw.operation), parseOk: true } : undefined
  return finishDraft(originalSql, dialect, parsed, true)
}

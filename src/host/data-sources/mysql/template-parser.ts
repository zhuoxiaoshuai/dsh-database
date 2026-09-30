import type { ParsedTemplateFeatures } from '../../sql-template-normalizer.ts'
import { classify, unique } from '../template-common.ts'

function collectMysql(node: unknown, bags: { tables: string[]; columns: string[]; conditions: string[]; joins: string[]; aggregates: string[]; groupBy: string[]; orderBy: string[] }, inWhere = false): void {
  if (!node || typeof node !== 'object') return
  const value = node as Record<string, unknown>
  if (value.type === 'column_ref' && typeof value.column === 'string') {
    bags.columns.push(value.column)
    if (inWhere) bags.conditions.push(value.column)
  }
  if (value.type === 'aggr_func' && typeof value.name === 'string') bags.aggregates.push(value.name.toUpperCase())
  if (Array.isArray(value.from)) {
    for (const from of value.from as Record<string, unknown>[]) {
      if (typeof from.table === 'string') bags.tables.push(from.table)
      if (from.join) bags.joins.push(String(from.join).toUpperCase())
    }
  }
  if (Array.isArray(value.groupby)) {
    for (const item of value.groupby as Record<string, unknown>[]) {
      if (typeof item.column === 'string') bags.groupBy.push(item.column)
    }
  }
  if (Array.isArray(value.orderby)) {
    for (const item of value.orderby as Record<string, unknown>[]) {
      const expr = item.expr as Record<string, unknown> | undefined
      if (expr && typeof expr.column === 'string') bags.orderBy.push(expr.column)
    }
  }
  for (const [key, child] of Object.entries(value)) {
    collectMysql(child, bags, inWhere || key === 'where' || key === 'having')
  }
}

export async function parseTemplate(sql: string): Promise<ParsedTemplateFeatures | undefined> {
  try {
    const { default: mod } = await import('node-sql-parser')
    const parser = new mod.Parser()
    const parsed = parser.astify(sql, { database: 'MySQL' })
    const list = Array.isArray(parsed) ? parsed : [parsed]
    if (list.length !== 1 || !list[0]) return undefined
    const bags = { tables: [] as string[], columns: [] as string[], conditions: [] as string[], joins: [] as string[], aggregates: [] as string[], groupBy: [] as string[], orderBy: [] as string[] }
    collectMysql(list[0], bags)
    const operation = String((list[0] as { type?: string }).type || classify(sql)).toLowerCase()
    return {
      operation,
      tables: unique(bags.tables),
      columns: unique(bags.columns),
      conditionColumns: unique(bags.conditions),
      joins: unique(bags.joins),
      aggregates: unique(bags.aggregates),
      groupBy: unique(bags.groupBy),
      orderBy: unique(bags.orderBy),
    }
  } catch {
    return undefined
  }
}


type AntlrNode = {
  constructor: { name: string }
  children?: AntlrNode[]
  parentCtx?: AntlrNode
  getText(): string
}

type AntlrRecognizer = {
  removeErrorListeners(): void
  addErrorListener(listener: unknown): void
}

export type OracleTemplateAst = {
  operation: string
  tables: string[]
  columns: string[]
  conditionColumns: string[]
  joins: string[]
  aggregates: string[]
  groupBy: string[]
  orderBy: string[]
}

const AGGREGATES = new Set([
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'MEDIAN', 'LISTAGG',
  'STDDEV', 'STDDEV_POP', 'STDDEV_SAMP', 'VARIANCE', 'VAR_POP', 'VAR_SAMP',
  'GROUPING', 'GROUPING_ID', 'CORR', 'COVAR_POP', 'COVAR_SAMP',
])

const OPERATIONS: Record<string, string> = {
  Select_statementContext: 'select',
  Insert_statementContext: 'insert',
  Update_statementContext: 'update',
  Delete_statementContext: 'delete',
  Merge_statementContext: 'merge',
}

const CONDITION_CONTEXTS = new Set([
  'Where_clauseContext',
  'Having_clauseContext',
  'Join_on_partContext',
  'Join_using_partContext',
])

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort()
}

export function normalizeOracleIdentifier(raw: string): string {
  const text = raw.trim()
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) return text.slice(1, -1).replaceAll('""', '"')
  return text.toUpperCase()
}

function identifierParts(text: string): string[] {
  return (text.match(/"(?:[^"]|"")*"|[^.]+/g) || []).map(normalizeOracleIdentifier)
}

function hasAncestor(node: AntlrNode, kind: string): boolean {
  for (let ancestor = node.parentCtx; ancestor; ancestor = ancestor.parentCtx) {
    if (ancestor.constructor.name === kind) return true
  }
  return false
}

function inCondition(node: AntlrNode): boolean {
  for (let ancestor = node.parentCtx; ancestor; ancestor = ancestor.parentCtx) {
    const kind = ancestor.constructor.name
    if (CONDITION_CONTEXTS.has(kind)) return true
    if (kind === 'ConditionContext' && hasAncestor(ancestor, 'Merge_statementContext') && !hasAncestor(ancestor, 'Where_clauseContext')) return true
  }
  return false
}

function joinKind(node: AntlrNode): string {
  const tokens: string[] = []
  const visit = (child: AntlrNode) => {
    const kind = child.constructor.name
    if (kind === 'Table_ref_auxContext') return
    if (kind === 'Outer_join_typeContext') {
      tokens.push(child.getText().replace(/\s+/g, ' ').trim().toUpperCase())
      return
    }
    if (!child.children?.length) {
      const text = child.getText().toUpperCase()
      if (['INNER', 'CROSS', 'NATURAL', 'JOIN', 'FULL', 'LEFT', 'RIGHT', 'OUTER', 'APPLY'].includes(text)) tokens.push(text)
      return
    }
    for (const next of child.children) visit(next)
  }
  for (const child of node.children || []) visit(child)
  return tokens.join(' ').replace(/\s+/g, ' ').trim() || 'JOIN'
}

function collectVisibleCtes(node: AntlrNode): Set<string> {
  const names = new Set<string>()
  const collect = (current: AntlrNode) => {
    if (current.constructor.name === 'Subquery_factoring_clauseContext') {
      const name = current.children?.find(child => child.constructor.name === 'Query_nameContext')
      if (name) names.add(normalizeOracleIdentifier(name.getText()))
      return
    }
    for (const child of current.children || []) collect(child)
  }
  for (let ancestor = node.parentCtx; ancestor; ancestor = ancestor.parentCtx) {
    for (const child of ancestor.children || []) {
      if (child.constructor.name === 'With_clauseContext') collect(child)
    }
  }
  return names
}

function collect(node: AntlrNode, bags: {
  tables: string[]
  columns: string[]
  conditions: string[]
  joins: string[]
  aggregates: string[]
  groupBy: string[]
  orderBy: string[]
}): void {
  const kind = node.constructor.name
  if (kind === 'Tableview_nameContext') {
    const names = identifierParts(node.getText())
    const table = names.at(-1) || ''
    if (table && table !== 'DUAL' && (names.length === 2 || !collectVisibleCtes(node).has(table))) bags.tables.push(table)
  }
  if (kind === 'Join_clauseContext') bags.joins.push(joinKind(node))
  if ((kind === 'Standard_functionContext' || kind === 'Numeric_functionContext')) {
    const name = node.getText().match(/^[A-Za-z_][\w$]*/)?.[0]?.toUpperCase()
    if (name && AGGREGATES.has(name)) bags.aggregates.push(name)
  }
  if (kind === 'General_elementContext' && node.parentCtx?.constructor.name !== 'General_elementContext' && !node.getText().includes('(')) {
    const column = identifierParts(node.getText()).at(-1)
    if (column) {
      bags.columns.push(column)
      if (inCondition(node)) bags.conditions.push(column)
      if (hasAncestor(node, 'Group_by_elementsContext')) bags.groupBy.push(column)
      if (hasAncestor(node, 'Order_by_elementsContext')) bags.orderBy.push(column)
    }
  }
  if (kind === 'Column_nameContext') {
    const column = identifierParts(node.getText()).at(-1)
    if (column) {
      bags.columns.push(column)
      if (inCondition(node)) bags.conditions.push(column)
      if (hasAncestor(node, 'Group_by_elementsContext')) bags.groupBy.push(column)
      if (hasAncestor(node, 'Order_by_elementsContext')) bags.orderBy.push(column)
    }
  }
  for (const child of node.children || []) collect(child, bags)
}

export async function collectOracleTemplateAst(sql: string): Promise<OracleTemplateAst | undefined> {
  try {
    const { CharStream, CommonTokenStream } = await import('antlr4')
    const { PlSqlLexer, PlSqlParser } = await import('@griffithswaite/ts-plsql-parser')
    const lexer = new PlSqlLexer(new CharStream(sql)) as unknown as AntlrRecognizer
    const tokens = new CommonTokenStream(lexer)
    const parser = new PlSqlParser(tokens) as unknown as AntlrRecognizer & { sql_script(): { unit_statement_list(): AntlrNode[] } }
    let invalid = false
    const listener = {
      syntaxError() { invalid = true },
      reportAmbiguity() {},
      reportAttemptingFullContext() {},
      reportContextSensitivity() {},
    }
    lexer.removeErrorListeners()
    lexer.addErrorListener(listener)
    parser.removeErrorListeners()
    parser.addErrorListener(listener)
    const root = parser.sql_script()
    const units = root.unit_statement_list()
    if (invalid || units.length !== 1) return undefined
    const statement = units[0]?.children?.[0]?.children?.[0]
    const operation = OPERATIONS[statement?.constructor.name || '']
    if (!statement || !operation) return undefined
    const bags = { tables: [] as string[], columns: [] as string[], conditions: [] as string[], joins: [] as string[], aggregates: [] as string[], groupBy: [] as string[], orderBy: [] as string[] }
    collect(statement, bags)
    const head = sql.trim().replace(/^\(+/, '').replace(/;+\s*$/, '')
    return {
      operation: /^with\b/i.test(head) ? 'with' : operation,
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

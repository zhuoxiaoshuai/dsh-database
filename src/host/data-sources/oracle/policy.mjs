import { splitStatements, systemSchemas } from '../sql-policy-common.mjs'

export { splitStatements }
export function extractExplainSql(sql) {
  const trimmed = sql.trim().replace(/;\s*$/, '')
  const match = trimmed.match(/^EXPLAIN\s+PLAN\s+FOR\s+([\s\S]+)$/i)
  return match ? match[1].trim() : ''
}

export async function validateMaintenanceSelect(sql) {
  const { CharStream, CommonTokenStream } = await import('antlr4')
  const { PlSqlLexer, PlSqlParser } = await import('@griffithswaite/ts-plsql-parser')
  const lexer = new PlSqlLexer(new CharStream(sql)), tokens = new CommonTokenStream(lexer), parser = new PlSqlParser(tokens)
  let invalid = false
  const listener = { syntaxError() { invalid = true }, reportAmbiguity() {}, reportAttemptingFullContext() {}, reportContextSensitivity() {} }
  lexer.removeErrorListeners(); lexer.addErrorListener(listener); parser.removeErrorListeners(); parser.addErrorListener(listener)
  const units = parser.sql_script().unit_statement_list()
  return !invalid && units.length === 1
}

export async function authorize(sql, schema) {
  const tables = new Set(), ctes = new Set(), references = [], aliases = new Set()
  const { CharStream, CommonTokenStream } = await import('antlr4')
  const { PlSqlLexer, PlSqlParser } = await import('@griffithswaite/ts-plsql-parser')
  const lexer = new PlSqlLexer(new CharStream(sql)), tokens = new CommonTokenStream(lexer), parser = new PlSqlParser(tokens)
  // Any parser diagnostic prevents a complete authorization decision.
  let invalid = false
  const listener = { syntaxError() { invalid = true }, reportAmbiguity() {}, reportAttemptingFullContext() {}, reportContextSensitivity() {} }
  lexer.removeErrorListeners(); lexer.addErrorListener(listener); parser.removeErrorListeners(); parser.addErrorListener(listener)
  const root = parser.sql_script(), units = root.unit_statement_list()
  if (invalid || units.length !== 1) throw new Error('无法完整校验该语法，不执行。')
  const statement = units[0]?.children?.[0]?.children?.[0]
  const kindName = statement?.constructor.name || ''
  const isRead = kindName === 'Select_statementContext'
  if (!isRead && kindName !== 'Insert_statementContext' && kindName !== 'Update_statementContext' && kindName !== 'Delete_statementContext') throw new Error('无法完整校验该语法，不执行。')
  const identifier = s => s.startsWith('"') ? s.slice(1, -1).replaceAll('""', '"') : s.toUpperCase()
  if (/@/.test(units[0].getText())) throw new Error('不允许数据库链接。')
  const checkAll = node => {
    if (!node) return
    if (/^For_update/.test(node.constructor.name)) throw new Error('不支持锁定读。')
    if (node.constructor.name === 'Tableview_nameContext') {
      const names = (node.getText().match(/"(?:[^"]|"")*"|[^.]+/g) || []).map(identifier)
      if (names.length >= 2 && systemSchemas.has(names[0].toLowerCase())) throw new Error('不允许访问系统库对象。')
    }
    for (const child of node.children || []) checkAll(child)
  }
  checkAll(statement)
  if (!isRead) {
    const writeTargets = []
    let foundTarget = false
    const walkT = node => {
      if (foundTarget || !node) return
      if (node.constructor.name === 'Tableview_nameContext') {
        const names = (node.getText().match(/"(?:[^"]|"")*"|[^.]+/g) || []).map(identifier)
        if (names.length === 2 && systemSchemas.has(names[0].toLowerCase())) throw new Error('不允许访问系统库对象。')
        const name = names.at(-1) || ''
        tables.add(name)
        writeTargets.push({ schema: names.length >= 2 ? names[0] : schema, name })
        foundTarget = true
        return
      }
      for (const child of node.children || []) walkT(child)
    }
    walkT(statement)
    return { kind: 'write', tables: [...tables].filter(t => t && t !== 'DUAL'), targets: writeTargets.filter(t => t.name && t.name !== 'DUAL'), references, aliases, sql: sql.trim().replace(/;\s*$/, '') }
  }
  const walk = node => {
    const kind = node.constructor.name
    if (/^(For_update|Into|Function_body|Procedure_body|Model_clause|Pivot_|Unpivot_|Flashback|Hierarchical|Sample_|Dblink|Outer_join_sign)/.test(kind)) throw new Error('查询包含尚未验证的 Oracle 语法。')
    if (kind === 'Query_nameContext') ctes.add(identifier(node.getText()))
    if (kind === 'Table_aliasContext') aliases.add(identifier(node.getText()))
    if (kind === 'General_elementContext' && node.parentCtx?.constructor.name !== 'General_elementContext' && !node.getText().includes('(')) references.push((node.getText().match(/"(?:[^"]|"")*"|[^.]+/g) || []).map(identifier))
    if (kind === 'Tableview_nameContext') {
      if (node.children.some(c => c.getText() === '@')) throw new Error('不允许数据库链接。')
      const names = (node.getText().match(/"(?:[^"]|"")*"|[^.]+/g) || []).map(identifier)
      if (names.length === 2 && systemSchemas.has(names[0].toLowerCase())) throw new Error('不允许访问系统库对象。')
      const visibleCtes = new Set()
      const collectNames = n => {
        if (n.constructor.name === 'Subquery_factoring_clauseContext') { const name = n.children?.find(c => c.constructor.name === 'Query_nameContext'); if (name) visibleCtes.add(identifier(name.getText())); return }
        for (const child of n.children || []) collectNames(child)
      }
      for (let ancestor = node.parentCtx; ancestor; ancestor = ancestor.parentCtx) for (const child of ancestor.children || []) if (child.constructor.name === 'With_clauseContext') collectNames(child)
      const table = identifier(names.at(-1) || '')
      if (names.length === 2 || !visibleCtes.has(table)) tables.add(table)
    }
    for (const child of node.children || []) walk(child)
  }
  walk(root)
  return { kind: 'select', tables: [...tables].filter(t => t !== 'DUAL'), references, aliases: [...aliases, ...ctes], sql: sql.trim().replace(/;\s*$/, '') }
}

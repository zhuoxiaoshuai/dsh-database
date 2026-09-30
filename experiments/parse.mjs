/** M0 parser feasibility probe, NOT an SQL safety policy or executor. */
import mysqlPackage from 'node-sql-parser'
import { CharStream, CommonTokenStream } from 'antlr4'
import { PlSqlLexer, PlSqlParser } from '@griffithswaite/ts-plsql-parser'

export function inspectSyntax(dialect, sql) {
  if (Buffer.byteLength(sql, 'utf8') > 16384) throw new Error('SQL probe size limit')
  if (dialect === 'mysql') {
    const parser = new mysqlPackage.Parser()
    try {
      const value = parser.astify(sql, { database: 'MySQL' })
      const statements = Array.isArray(value) ? value : [value]
      return { parsed: true, statements: statements.length, types: statements.map(s => s.type) }
    } catch { return { parsed: false, statements: 0, types: [] } }
  }
  const errors = []
  const listener = { syntaxError(_recognizer, _symbol, line, column) { errors.push({ line, column }) }, reportAmbiguity() {}, reportAttemptingFullContext() {}, reportContextSensitivity() {} }
  const lexer = new PlSqlLexer(new CharStream(sql)); lexer.removeErrorListeners(); lexer.addErrorListener(listener)
  const tokens = new CommonTokenStream(lexer), parser = new PlSqlParser(tokens)
  parser.removeErrorListeners(); parser.addErrorListener(listener)
  const tree = parser.sql_script()
  const units = tree.unit_statement_list()
  return { parsed: errors.length === 0, statements: units.length, types: units.map(node => node.children?.[0]?.constructor.name || 'unknown'), errors }
}

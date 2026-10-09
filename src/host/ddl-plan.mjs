import { quoteIdentifier } from './query-policy.mjs'
import { getSqlDialect } from './dialects/registry.mjs'

export function createDdlPlan(dialect, schema, table, operations, metadata, sqlMode = '') {
  const sqlDialect = getSqlDialect(dialect)
  if (!Array.isArray(operations) || !operations.length || operations.length > 20) throw new Error('一次结构保存需要 1 到 20 个有序步骤。')
  const identifier = name => quoteIdentifier(dialect, name, {
    maxBytes: sqlDialect.maxIdentifierBytes,
    rejectControls: true,
    requireNonWhitespace: true,
    errorMessage: '对象名称无效或过长。',
  })
  const literal = value => { if (typeof value !== 'string' || value.length > 4000 || value.includes('\0')) throw new Error('文本值无效或过长。'); value = sqlDialect.escapeLiteral(value, sqlMode); return "'" + value.replaceAll("'", "''") + "'" }
  let current = table, existing = new Set((metadata?.columns || []).map(c => c.name)), destructive = false
  const indexes = new Set((metadata?.indexes?.values || []).map(i => i.name ?? i.INDEX_NAME ?? i.index_name))
  const constraints = new Set((metadata?.constraints?.values || []).map(c => c.name ?? c.CONSTRAINT_NAME ?? c.constraint_name))
  const qualified = name => identifier(schema) + '.' + identifier(name)
  const definition = column => {
    if (!column || typeof column.type !== 'string') throw new Error('请指定字段类型。')
    const type = column.type.trim().toUpperCase()
    if (!sqlDialect.columnTypePattern.test(type)) throw new Error('字段类型尚未验证。')
    let text = `${identifier(column.name)} ${type}`
    if (column.identity) text += sqlDialect.identityClause
    if (Object.hasOwn(column, 'default')) text += column.default === null ? ' DEFAULT NULL' : ' DEFAULT ' + literal(column.default)
    text += column.nullable === false ? ' NOT NULL' : ' NULL'
    if (sqlDialect.inlineColumnComment && column.comment !== undefined) text += ' COMMENT ' + literal(column.comment)
    return text
  }
  const columns = values => { if (!Array.isArray(values) || !values.length || values.length > 16 || values.some(c => !existing.has(c))) throw new Error('索引或约束字段无效。'); return values.map(identifier).join(', ') }
  const steps = []
  for (const operation of operations) {
    if (!operation || typeof operation.kind !== 'string') throw new Error('结构步骤无效。')
    const target = qualified(current), beforeTable = current
    let sql
    switch (operation.kind) {
      case 'createTable': {
        if (steps.length || metadata?.columns?.length || !Array.isArray(operation.columns) || !operation.columns.length || operation.columns.length > 100) throw new Error('建表需指定 1 到 100 个字段，且目标尚不存在。')
        existing = new Set(operation.columns.map(c => c.name)); if (existing.size !== operation.columns.length) throw new Error('字段名称重复。')
        const fields = operation.columns.map(definition)
        if (operation.primary?.length) fields.push('PRIMARY KEY (' + columns(operation.primary) + ')')
        sql = `CREATE TABLE ${target} (${fields.join(', ')})${sqlDialect.createTableSuffix}`; break
      }
      case 'renameTable': sql = sqlDialect.renameTable(target, identifier(operation.name), qualified(operation.name)); current = operation.name; break
      case 'comment': sql = sqlDialect.commentTable(target, literal(operation.comment)); break
      case 'columnComment': if (!existing.has(operation.name) || !sqlDialect.supportsColumnComment) throw new Error('MySQL 字段注释请通过修改字段保存完整定义。'); sql = `COMMENT ON COLUMN ${target}.${identifier(operation.name)} IS ${literal(operation.comment)}`; break
      case 'addColumn': if (existing.has(operation.column?.name)) throw new Error('字段已存在。'); sql = `ALTER TABLE ${target} ADD ${sqlDialect.columnDefinition(definition(operation.column))}`; existing.add(operation.column.name); break
      case 'modifyColumn': if (!existing.has(operation.column?.name)) throw new Error('字段不存在。'); destructive = true; sql = `ALTER TABLE ${target} MODIFY ${sqlDialect.columnDefinition(definition(operation.column))}`; break
      case 'dropColumn': if (!existing.has(operation.name) || existing.size === 1) throw new Error('字段不存在或为最后一个字段。'); destructive = true; sql = `ALTER TABLE ${target} DROP COLUMN ${identifier(operation.name)}`; existing.delete(operation.name); break
      case 'addIndex': if (indexes.has(operation.name)) throw new Error('索引已存在。'); sql = `CREATE ${operation.unique ? 'UNIQUE ' : ''}INDEX ${sqlDialect.indexName(identifier(operation.name), qualified(operation.name))} ON ${target} (${columns(operation.columns)})`; indexes.add(operation.name); break
      case 'dropIndex': if (!indexes.has(operation.name)) throw new Error('该索引不属于目标表。'); sql = sqlDialect.dropIndex(target, identifier(operation.name), qualified(operation.name)); indexes.delete(operation.name); break
      case 'addConstraint': {
        let body
        if (operation.type === 'primary' || operation.type === 'unique') body = `${operation.type === 'primary' ? 'PRIMARY KEY' : 'UNIQUE'} (${columns(operation.columns)})`
        else if (operation.type === 'foreign') { if (!Array.isArray(operation.references?.columns) || !operation.references.columns.length || operation.references.columns.length !== operation.columns?.length) throw new Error('外键引用无效。'); body = `FOREIGN KEY (${columns(operation.columns)}) REFERENCES ${qualified(operation.references.table)} (${operation.references.columns.map(identifier).join(', ')})` }
        else if (operation.type === 'check') { const operators = { eq: '=', ne: '<>', gt: '>', lt: '<', gte: '>=', lte: '<=' }; if (!existing.has(operation.check?.column) || !Object.hasOwn(operators, operation.check?.operator)) throw new Error('检查约束无效。'); const v = operation.check.value; if (typeof v !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(v)) throw new Error('此检查约束仅支持精确数字比较。'); body = `CHECK (${identifier(operation.check.column)} ${operators[operation.check.operator]} ${v})` }
        else throw new Error('约束类型无效。')
        if (constraints.has(operation.name)) throw new Error('约束已存在。'); constraints.add(operation.name)
        sql = `ALTER TABLE ${target} ADD CONSTRAINT ${identifier(operation.name)} ${body}`; break
      }
      case 'dropConstraint': {
        if (!constraints.has(operation.name)) throw new Error('该约束不属于目标表。'); constraints.delete(operation.name)
        const found = metadata?.constraints?.values?.find(c => (c.name ?? c.CONSTRAINT_NAME) === operation.name)
        const clause = constraintName => {
          if (!found) throw new Error('约束不存在。')
          const rawType = found.type || found.CONSTRAINT_TYPE
          const value = { primary: 'PRIMARY KEY', 'PRIMARY KEY': 'PRIMARY KEY', foreign: 'FOREIGN KEY ' + constraintName, 'FOREIGN KEY': 'FOREIGN KEY ' + constraintName, unique: 'INDEX ' + constraintName, UNIQUE: 'INDEX ' + constraintName, check: 'CHECK ' + constraintName, CHECK: 'CHECK ' + constraintName }[rawType]
          if (!value) throw new Error('约束类型尚未验证。')
          return value
        }
        sql = sqlDialect.dropConstraint(target, identifier(operation.name), clause)
        break
      }
      case 'dropTable': destructive = true; sql = `DROP TABLE ${target}`; break
      case 'truncateTable': destructive = true; sql = `TRUNCATE TABLE ${target}`; break
      case 'analyzeTable':
        if (operation.name !== undefined && operation.name !== current) throw new Error('统计维护必须使用已检查的目标表。')
        sql = sqlDialect.analyzeTable(target, schema, current); break
      default: throw new Error('结构操作尚未支持。')
    }
    steps.push({ kind: operation.kind, table: beforeTable, afterTable: current, sql, state: 'not-run' })
    if (operation.kind === 'dropTable' && steps.length !== operations.length) throw new Error('删除表必须为最后一步。')
  }
  if (Buffer.byteLength(JSON.stringify(steps)) > 16384) throw new Error('结构变更超过 16 KiB。')
  return { kind: 'ddl', schema, table, finalTable: current, steps, destructive, sqlMode, operations: structuredClone(operations) }
}

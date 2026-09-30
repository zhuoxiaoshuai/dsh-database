import { authorizeByLead, ONLY_SHOW, recordTable, splitStatements, WRITE_ONLY } from '../sql-policy-common.mjs'

const SHOW_INDEX_FROM = /^SHOW\s+(STORAGE\s+)?INDEX\s+FROM\s+`?([A-Za-z0-9_]+)`?/i
const SHOW_TABLE_STATUS = /^SHOW\s+TABLE\s+STATUS(?:\s+FROM\s+`?([A-Za-z0-9_]+)`?)?/i


export { splitStatements }
export function extractExplainSql(sql) {
  const trimmed = sql.trim().replace(/;\s*$/, '')
  const match = trimmed.match(/^EXPLAIN\s+(?:FORMAT\s*=\s*\w+\s+)?([\s\S]+)$/i)
  return match ? match[1].trim() : ''
}

export async function validateMaintenanceSelect(sql) {
  const { default: mod } = await import('node-sql-parser')
  const root = new mod.Parser().astify(sql, { database: 'MySQL' })
  return !Array.isArray(root) && root?.type === 'select'
}

export async function authorize(sql, schema) {
  const tables = new Set(), ctes = new Set(), references = [], aliases = new Set()
  const leading = sql.trim().replace(/^--[\s\S]*?\n/, '').trim()
  if (/^SHOW\s/i.test(leading)) {
    const idx = leading.match(SHOW_INDEX_FROM)
    if (idx) {
      tables.add(idx[2])
      return { kind: 'show', tables: [...tables].filter(Boolean), references, aliases, sql: sql.trim().replace(/;\s*$/, '') }
    }
    if (SHOW_TABLE_STATUS.test(leading)) {
      return { kind: 'show', tables: [], references, aliases, sql: sql.trim().replace(/;\s*$/, '') }
    }
    throw new Error(ONLY_SHOW)
  }
  const { default: mod } = await import('node-sql-parser')
  const parser = new mod.Parser()
  let root
  try {
    root = parser.astify(sql, { database: 'MySQL' })
    if (Array.isArray(root)) {
      if (root.length !== 1) return authorizeByLead(sql, schema)
      root = root[0]
    }
  } catch {
    return authorizeByLead(sql, schema)
  }
  if (root.type === 'select') {
    if (root.into?.position) throw new Error('不允许 SELECT INTO OUTFILE/DUMPFILE 写文件。')
    if (root.locking_read) throw new Error('只读会话不支持锁定读（FOR UPDATE / LOCK IN SHARE MODE）。')
    for (const cte of root.with || []) ctes.add(cte.name.value)
    const walk = (node, inherited = new Set()) => {
      if (!node || typeof node !== 'object') return
      if (node.type && ['insert', 'update', 'delete', 'replace', 'assign', 'var', 'call', 'set', 'use'].includes(node.type)) throw new Error('查询包含非只读语句。')
      const scope = new Set(inherited)
      for (const cte of node.with || []) scope.add(cte.name.value)
      for (const from of node.from || []) if (from.table && (from.db || !scope.has(from.table))) recordTable(tables, from)
      for (const value of Object.values(node)) if (typeof value === 'object') Array.isArray(value) ? value.forEach(child => walk(child, scope)) : walk(value, scope)
    }
    walk(root)
    return { kind: 'select', tables: [...tables].filter(Boolean), references, aliases, sql: sql.trim().replace(/;\s*$/, '') }
  }
  if (root.type === 'insert' || root.type === 'update' || root.type === 'replace' || root.type === 'delete') {
    const source = root.type === 'delete'
      ? [...(Array.isArray(root.table) ? root.table : root.table ? [root.table] : []), ...(Array.isArray(root.from) ? root.from : [])]
      : root.table
    const writeTargets = []
    const seen = new Set()
    for (const t of Array.isArray(source) ? source : [source]) if (t?.table) {
      recordTable(tables, t)
      const target = { schema: t.db || schema, name: t.table }
      const key = `${target.schema}\0${target.name}`
      if (seen.has(key)) continue
      seen.add(key)
      writeTargets.push(target)
    }
    return { kind: 'write', tables: [...tables].filter(Boolean), targets: writeTargets, references, aliases, sql: sql.trim().replace(/;\s*$/, '') }
  }
  throw new Error(WRITE_ONLY)
}

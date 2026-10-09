import { ONLY_SHOW, recordTable, splitStatements, WRITE_ONLY, systemSchemas } from '../sql-policy-common.mjs'

const identifier = '(?:`((?:[^`]|``)+)`|([A-Za-z0-9_$]+))'
const SHOW_INDEX_FROM = new RegExp('^SHOW\\s+INDEX\\s+FROM\\s+' + identifier + '(?:\\s*\\.\\s*' + identifier + ')?(?:\\s+FROM\\s+' + identifier + ')?\\s*;?$', 'i')
const SHOW_TABLE_STATUS = new RegExp('^SHOW\\s+TABLE\\s+STATUS(?:\\s+FROM\\s+' + identifier + ')?\\s*;?$', 'i')


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
      const first = idx[1] || idx[2], second = idx[3] || idx[4], from = idx[5] || idx[6]
      const target = second ? first : from || schema
      if (systemSchemas.has(target.toLowerCase())) throw new Error('不允许访问系统库对象。')
      if (second && from && first !== from) throw new Error('执行目标不一致。')
      tables.add(second || first)
      return { kind: 'show', tables: [...tables].filter(Boolean), references, aliases, sql: sql.trim().replace(/;\s*$/, '') }
    }
    const status = leading.match(SHOW_TABLE_STATUS)
    if (status) {
      if (systemSchemas.has((status[1] || status[2] || schema).toLowerCase())) throw new Error('不允许访问系统库对象。')
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
      if (root.length !== 1) throw new Error('无法完整校验该语法，不执行。')
      root = root[0]
    }
  } catch {
    throw new Error('无法完整校验该语法，不执行。')
  }
  if (root.type === 'select') {
    for (const cte of root.with || []) ctes.add(cte.name.value)
    const walk = (node, inherited = new Set()) => {
      if (!node || typeof node !== 'object') return
      if (node.locking_read) throw new Error('只读会话不支持锁定读（FOR UPDATE / LOCK IN SHARE MODE）。')
      if (node.into?.position) throw new Error('不允许 SELECT INTO OUTFILE/DUMPFILE 写文件。')
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
    const check = node => {
      if (!node || typeof node !== 'object') return
      if (node.locking_read || node.into?.position) throw new Error('写入中的查询不支持锁定读或写文件。')
      if (node.table && typeof node.table === 'string') recordTable(tables, node)
      for (const value of Object.values(node)) if (typeof value === 'object') Array.isArray(value) ? value.forEach(check) : check(value)
    }
    check(root)
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

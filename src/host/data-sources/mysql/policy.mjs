import { recordTable, splitStatements, unverifiedStatement } from '../sql-policy-common.mjs'

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
  // MySQL executes version comments, while the parser treats them as comments.
  // Skip quoted text and ordinary comments before deciding whether a read is proven.
  const regions = /'(?:\\.|''|[^'\\])*'|"(?:\\.|""|[^"\\])*"|`(?:``|[^`])*`|--(?=\s|$)[^\r\n]*|#[^\r\n]*|\/\*[\s\S]*?\*\//g
  if ([...sql.matchAll(regions)].some(match => match[0].startsWith('/*!'))) return unverifiedStatement(sql)
  const tables = new Set(), ctes = new Set(), references = [], aliases = new Set()
  const leading = sql.trim().replace(/^--[\s\S]*?\n/, '').trim()
  if (/^SHOW\s/i.test(leading)) {
    const idx = leading.match(SHOW_INDEX_FROM)
    if (idx) {
      const first = idx[1] || idx[2], second = idx[3] || idx[4], from = idx[5] || idx[6]
      if (second && from && first !== from) throw new Error('执行目标不一致。')
      tables.add(second || first)
      return { kind: 'show', tables: [...tables].filter(Boolean), references, aliases, sql: sql.trim().replace(/;\s*$/, '') }
    }
    const status = leading.match(SHOW_TABLE_STATUS)
    if (status) return { kind: 'show', tables: [], references, aliases, sql: sql.trim().replace(/;\s*$/, '') }
    return unverifiedStatement(sql)
  }
  const { default: mod } = await import('node-sql-parser')
  const parser = new mod.Parser()
  let root
  try {
    root = parser.astify(sql, { database: 'MySQL' })
    if (Array.isArray(root)) {
      if (root.length !== 1) return unverifiedStatement(sql)
      root = root[0]
    }
  } catch {
    return unverifiedStatement(sql)
  }
  if (!root?.type) return unverifiedStatement(sql)
  if (root.type === 'select') {
    let writesFile = false
    for (const cte of root.with || []) ctes.add(cte.name.value)
    const walk = (node, inherited = new Set()) => {
      if (!node || typeof node !== 'object') return
      if (['OUTFILE', 'DUMPFILE'].includes(node.into?.keyword?.toUpperCase())) writesFile = true
      const scope = new Set(inherited)
      for (const cte of node.with || []) scope.add(cte.name.value)
      for (const from of node.from || []) if (from.table && (from.db || !scope.has(from.table))) recordTable(tables, from)
      for (const value of Object.values(node)) if (typeof value === 'object') Array.isArray(value) ? value.forEach(child => walk(child, scope)) : walk(value, scope)
    }
    walk(root)
    if (writesFile) return unverifiedStatement(sql)
    return { kind: 'select', tables: [...tables].filter(Boolean), references, aliases, sql: sql.trim().replace(/;\s*$/, '') }
  }
  if (root.type === 'insert' || root.type === 'update' || root.type === 'replace' || root.type === 'delete') {
    const check = node => {
      if (!node || typeof node !== 'object') return
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
  return unverifiedStatement(sql)
}

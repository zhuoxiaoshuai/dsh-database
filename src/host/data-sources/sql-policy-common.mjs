export const systemSchemas = new Set(['mysql', 'information_schema', 'performance_schema', 'sys', 'system', 'xdb', 'outln'])
export const WRITE_ONLY = '暂只开放查询与增删改（SELECT / INSERT / UPDATE / DELETE）；DDL 与工具语句未开放。'
export const ONLY_SHOW = '只允许 SHOW INDEX、SHOW TABLE STATUS 等只读统计语句。'

function strippedSql(sql) {
  return sql.trim().replace(/;\s*$/, '')
}

function leadKind(sql) {
  let text = sql.trim()
  for (;;) {
    const next = text.replace(/^--[^\n]*(?:\r?\n|$)/, '').replace(/^#[^\n]*(?:\r?\n|$)/, '').replace(/^\/\*[\s\S]*?\*\//, '').trim()
    if (next === text) return text
    text = next
  }
}

function statementKind(sql) {
  const text = leadKind(sql)
  if (/^(SELECT|WITH)\b/i.test(text)) return 'select'
  if (/^(INSERT|REPLACE|UPDATE|DELETE)\b/i.test(text)) return 'write'
  return null
}

export function splitStatements(sql) {
  const text = String(sql || '')
  const parts = []
  let i = 0, start = 0, started = false
  const n = text.length
  const emit = end => {
    if (!started) return
    const part = text.slice(start, end).trim().replace(/;\s*$/, '')
    if (part && leadKind(part)) parts.push(part)
    started = false
  }
  while (i < n) {
    const ch = text[i]
    if (ch === '-' && text[i + 1] === '-') {
      i += 2
      while (i < n && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '#') {
      while (i < n && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i + 1 < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch
      started = true
      i += 1
      while (i < n) {
        if (quote === '\'' && text[i] === '\\') { i += 2; continue }
        if (text[i] === quote) {
          if (text[i + 1] === quote) { i += 2; continue }
          break
        }
        i += 1
      }
      i += 1
      continue
    }
    if (ch === ';') {
      emit(i)
      i += 1
      start = i
      continue
    }
    if (!/\s/.test(ch)) started = true
    i += 1
  }
  emit(n)
  return parts
}

export function aliasesOf(value) {
  return Array.isArray(value) ? value : value ? [...value] : []
}

export function authorizeByLead(sql, schema) {
  const kind = statementKind(sql)
  const trimmed = strippedSql(sql)
  if (kind === 'select') return { kind: 'select', tables: [], references: [], aliases: [], sql: trimmed }
  if (kind === 'write') {
    const match = trimmed.match(/^(?:INSERT\s+(?:IGNORE\s+)?(?:INTO\s+)?|REPLACE\s+(?:INTO\s+)?|UPDATE\s+|DELETE\s+FROM\s+)(?:((?:`[^`]+`|"[^"]+"|[A-Za-z0-9_$#]+))\s*\.\s*)?((?:`[^`]+`|"[^"]+"|[A-Za-z0-9_$#]+))/i)
    const ident = value => String(value || '').replaceAll('`', '').replaceAll('"', '')
    const target = match ? { schema: ident(match[1]) || schema, name: ident(match[2]) } : undefined
    if (target?.schema && systemSchemas.has(target.schema.toLowerCase())) throw new Error('不允许访问系统库对象。')
    return {
      kind: 'write',
      tables: target?.name ? [target.name] : [],
      targets: target?.name ? [target] : [],
      references: [],
      aliases: [],
      sql: trimmed,
    }
  }
  throw new Error(WRITE_ONLY)
}

export const recordTable = (set, ref) => {
  const db = String(ref?.db || '')
  if (db && systemSchemas.has(db.toLowerCase())) throw new Error('不允许访问系统库对象。')
  const table = String(ref?.table || '')
  if (table) set.add(table)
}

// 通用输入校验：非空、大小、业务库。
export function guard(sql, schema) {
  if (typeof sql !== 'string' || !sql.trim() || Buffer.byteLength(sql) > 16000 || typeof schema !== 'string' || !schema || schema.length > 128 || systemSchemas.has(schema.toLowerCase())) throw new Error('请选择业务数据库（系统库不可作为目标），并输入不超过 16 KiB 的单条 SQL。')
  if (/\/\*[!+]/.test(sql)) throw new Error('暂不支持可执行注释或提示。')
}


import type { Dialect } from '../../../shared/workbench.ts'
import { dialectCapabilities } from '../../../shared/dialect-capabilities.ts'
import { skipRegion } from '../../../shared/sql-lex.ts'

export { enumerateStatements, isInsideCommentOrLiteral, locateStatement, type StatementRange } from '../../../shared/sql-lex.ts'

const BASE_KEYWORDS = 'SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER CROSS GROUP ORDER BY HAVING LIMIT OFFSET AND OR NOT IN LIKE BETWEEN IS NULL AS ON DISTINCT UNION INTERSECT EXCEPT MINUS INSERT INTO UPDATE SET DELETE VALUES FETCH FIRST NEXT ROWS ONLY STRAIGHT_JOIN WITH RECURSIVE'.split(' ')
const KEYWORDS = new Set(BASE_KEYWORDS)
const WHERE_KEYWORDS = ['AND', 'OR', 'IN', 'LIKE', 'IS NULL', 'IS NOT NULL', 'BETWEEN', 'NOT']
const TABLE_SLOT_KEYWORDS = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'STRAIGHT_JOIN'])
const JOIN_SLOT_KEYWORDS = new Set(['FROM', 'JOIN', 'STRAIGHT_JOIN'])
const SET_OP_KEYWORDS = new Set(['UNION', 'INTERSECT', 'EXCEPT', 'MINUS'])
const ALIAS_STOP = new Set(['ON', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'FETCH', 'SET', 'VALUES', 'UNION', 'SELECT', 'USING', 'FOR', 'NATURAL', 'PARTITION', 'WINDOW', 'PIVOT', 'UNPIVOT', 'START', 'CONNECT', 'LATERAL', 'APPLY', 'MATCH', 'STRAIGHT_JOIN', 'QUALIFY', 'SAMPLE', 'VERSIONS', 'TABLESAMPLE', 'OF', 'SCN', 'INTERSECT', 'EXCEPT', 'MINUS'])
const EXPRESSION_KEYWORDS = ['WHERE', 'ON', 'SET', 'SELECT', 'BY', 'HAVING', 'AND', 'OR', 'NOT', 'LIKE', 'IN', 'BETWEEN', 'DISTINCT', 'IS', 'NULL']

export type TableRef = {
  database?: string
  table: string
  alias?: string
  /** 子查询 / CTE 投影出的列；有值时不再按目录表名取列。 */
  columns?: { name: string; type?: string }[]
  /** `SELECT *` 展开成这些目录表的列。 */
  star?: { database?: string; table: string }[]
}
export type QueryScope = { tables: TableRef[]; aliases: Record<string, string> }
export type CompletionKind = 'table' | 'column' | 'expression' | 'keyword'
export type CompletionContext = {
  type: CompletionKind
  qualifier?: string
  schemaQualifier?: string
  allowViews?: boolean
  lastKeyword?: string
}
export type Suggestion = { label: string; insert: string; kind: 'table' | 'column' | 'keyword'; detail?: string; boost: number }
export type CompletionResult = { suggestions: Suggestion[]; pending: string[] }
type CatalogTable = { name: string; kind: 'table' | 'view' }
type CatalogColumn = { name: string; type?: string }
type ProjectionSource = { open: number; close: number; group?: number; explicit?: { name: string }[] }
type ScopedTable = TableRef & { path: number[]; block: number; source?: ProjectionSource }
type CteDef = { name: string; path: number[]; block: number; order: number; open: number; close: number; group?: number; explicit?: { name: string }[]; columns?: { name: string }[]; star?: { database?: string; table: string }[] }
type Token = { type: 'id' | 'kw' | 'dot' | 'punct'; value: string; from: number; to: number }

function unquote(value: string): string {
  if ((value.startsWith('`') && value.endsWith('`')) || (value.startsWith('"') && value.endsWith('"'))) return value.slice(1, -1).replaceAll(value[0] + value[0], value[0])
  return value
}

function sameIdent(left?: string, right?: string): boolean {
  if (!left || !right) return false
  return left.toLowerCase() === right.toLowerCase()
}

function skip(sql: string, start: number, dialect: Dialect = 'mysql'): { index: number; skipped: boolean } {
  const region = skipRegion(sql, start, dialect)
  if (region.kind === 'comment' || region.kind === 'string') return { index: region.index, skipped: true }
  if (region.kind === 'quotedIdent' && !region.closed) return { index: region.index, skipped: true }
  return { index: start, skipped: false }
}

function tokenize(sql: string, dialect: Dialect = 'mysql'): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < sql.length) {
    const skipped = skip(sql, i, dialect)
    if (skipped.skipped) { i = skipped.index; continue }
    if (/\s/.test(sql[i])) { i += 1; continue }
    if (sql[i] === '.') { tokens.push({ type: 'dot', value: '.', from: i, to: i + 1 }); i += 1; continue }
    if (/[(),*]/.test(sql[i])) { tokens.push({ type: 'punct', value: sql[i], from: i, to: i + 1 }); i += 1; continue }
    const ident = sql.slice(i).match(/^(?:`(?:``|[^`])*`|"(?:""|[^"])*"|[A-Za-z_][A-Za-z0-9_]*)/)
    if (ident) {
      const value = ident[0]
      const raw = unquote(value)
      tokens.push({ type: KEYWORDS.has(raw.toUpperCase()) && !value.startsWith('`') && !value.startsWith('"') ? 'kw' : 'id', value: raw, from: i, to: i + value.length })
      i += value.length
      continue
    }
    i += 1
  }
  return tokens
}

function scopeAt(tokens: Token[], offset: number): { path: number[]; blocks: number[] } {
  const stack = [0]
  const blocks = [0]
  let next = 1
  for (const token of tokens) {
    if (token.from >= offset) break
    if (token.type === 'punct' && token.value === '(') {
      stack.push(next++)
      blocks.push(0)
    } else if (token.type === 'punct' && token.value === ')' && stack.length > 1) {
      stack.pop()
      blocks.pop()
    } else if (token.type === 'kw' && SET_OP_KEYWORDS.has(token.value.toUpperCase())) {
      blocks[blocks.length - 1] += 1
    }
  }
  return { path: stack, blocks }
}

function isPathPrefix(path: number[], cursor: number[]): boolean {
  return path.length <= cursor.length && path.every((item, index) => item === cursor[index])
}

function inScopeAt(table: ScopedTable, cursor: { path: number[]; blocks: number[] }): boolean {
  if (!isPathPrefix(table.path, cursor.path)) return false
  return table.block === cursor.blocks[table.path.length - 1]
}

function toScope(items: ScopedTable[]): QueryScope {
  const tables: TableRef[] = []
  const aliases: Record<string, string> = {}
  for (const item of items) {
    const table: TableRef = { database: item.database, table: item.table, alias: item.alias }
    if (item.columns?.length) table.columns = item.columns
    if (item.star?.length) table.star = item.star
    tables.push(table)
    aliases[item.table.toLowerCase()] = item.table
    if (item.alias) aliases[item.alias.toLowerCase()] = item.table
  }
  return { tables, aliases }
}

function matchingParen(tokens: Token[], open: number): number {
  let depth = 0
  for (let index = open; index < tokens.length; index++) {
    if (tokens[index].type === 'punct' && tokens[index].value === '(') depth += 1
    else if (tokens[index].type === 'punct' && tokens[index].value === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return tokens.length - 1
}

function columnFromItem(item: Token[]): { name?: string; star?: { database?: string; table: string } } | undefined {
  if (!item.length) return undefined
  let depth = 0
  const top: Token[] = []
  for (const token of item) {
    if (token.type === 'punct' && token.value === '(') { depth += 1; continue }
    if (token.type === 'punct' && token.value === ')') { depth -= 1; continue }
    if (depth === 0) top.push(token)
  }
  const asAt = top.findIndex(token => token.type === 'kw' && token.value.toUpperCase() === 'AS')
  if (asAt >= 0) {
    const alias = top[asAt + 1]
    return alias?.type === 'id' ? { name: alias.value } : undefined
  }
  if (item.some(token => token.type === 'punct' && token.value === '(')) return undefined
  const starAt = top.findIndex(token => token.type === 'punct' && token.value === '*')
  if (starAt >= 0) {
    const ids = top.slice(0, starAt).filter(token => token.type === 'id').map(token => token.value)
    if (!ids.length) return { star: { table: '*' } }
    return { star: { database: ids.length > 1 ? ids[ids.length - 2] : undefined, table: ids[ids.length - 1] } }
  }
  const ids = top.filter(token => token.type === 'id')
  if (!ids.length) return undefined
  return { name: ids[ids.length - 1].value }
}

function selectProjection(tokens: Token[], open: number, close: number): { columns: { name: string }[]; star: { database?: string; table: string }[] } | undefined {
  let depth = 0
  let selectAt = -1
  for (let index = open; index <= close && index < tokens.length; index++) {
    const token = tokens[index]
    if (token.type === 'punct' && token.value === '(') depth += 1
    else if (token.type === 'punct' && token.value === ')') depth -= 1
    else if (depth === 1 && token.type === 'kw' && token.value.toUpperCase() === 'SELECT' && selectAt < 0) selectAt = index
  }
  if (selectAt < 0) return undefined
  const columns: { name: string }[] = []
  const star: { database?: string; table: string }[] = []
  let item: Token[] = []
  depth = 1
  const flush = () => {
    const parsed = columnFromItem(item)
    item = []
    if (parsed?.star) star.push(parsed.star)
    else if (parsed?.name) columns.push({ name: parsed.name })
  }
  for (let index = selectAt + 1; index < close; index++) {
    const token = tokens[index]
    if (token.type === 'punct' && token.value === '(') { depth += 1; item.push(token); continue }
    if (token.type === 'punct' && token.value === ')') { depth -= 1; item.push(token); continue }
    if (depth === 1 && token.type === 'kw' && token.value.toUpperCase() === 'FROM') break
    if (depth === 1 && token.type === 'punct' && token.value === ',') { flush(); continue }
    if (depth === 1 && token.type === 'kw' && token.value.toUpperCase() === 'DISTINCT' && !item.length) continue
    item.push(token)
  }
  flush()
  if (!columns.length && !star.length) return undefined
  return { columns, star }
}

function collectTables(sql: string, dialect: Dialect): { tables: ScopedTable[]; tokens: Token[] } {
  const tokens = tokenize(sql, dialect)
  const tables: ScopedTable[] = []
  const ctes: CteDef[] = []
  const add = (database: string | undefined, table: string, alias: string | undefined, path: number[], block: number, source?: ProjectionSource) => {
    tables.push({ database, table, alias, path: [...path], block, source })
  }
  const readAlias = (index: number) => {
    const next = tokens[index + 1]
    if (next?.type === 'kw' && next.value.toUpperCase() === 'AS' && tokens[index + 2]?.type === 'id') {
      if (tokens[index + 2].value.toUpperCase() === 'OF') return { end: index }
      return { alias: tokens[index + 2].value, end: index + 2 }
    }
    if (next?.type === 'id' && !ALIAS_STOP.has(next.value.toUpperCase())) {
      return { alias: next.value, end: index + 1 }
    }
    return { end: index }
  }
  const readTable = (start: number, path: number[], block: number) => {
    if (tokens[start]?.type !== 'id') return null
    let database: string | undefined
    let table = tokens[start].value
    let index = start
    if (tokens[start + 1]?.type === 'dot' && tokens[start + 2]?.type === 'id') {
      database = table
      table = tokens[start + 2].value
      index = start + 2
    }
    const aliased = readAlias(index)
    add(database, table, aliased.alias, path, block)
    return aliased.end
  }
  const stack = [0]
  const blocks = [0]
  let nextGroup = 1
  const pendingDerived: { path: number[]; block: number; open: number; group?: number }[] = []
  const noteCtes = (from: number, path: number[], block: number) => {
    let index = from + 1
    if (tokens[index]?.type === 'kw' && tokens[index].value.toUpperCase() === 'RECURSIVE') index += 1
    for (;;) {
      if (tokens[index]?.type !== 'id') return
      const name = tokens[index].value
      index += 1
      let explicit: { name: string }[] | undefined
      if (tokens[index]?.type === 'punct' && tokens[index].value === '(') {
        const close = matchingParen(tokens, index)
        const names: { name: string }[] = []
        let depth = 0
        for (let cursor = index; cursor <= close; cursor++) {
          if (tokens[cursor].type === 'punct' && tokens[cursor].value === '(') depth += 1
          else if (tokens[cursor].type === 'punct' && tokens[cursor].value === ')') depth -= 1
          else if (depth === 1 && tokens[cursor].type === 'id') names.push({ name: tokens[cursor].value })
        }
        if (tokens[close + 1]?.type === 'kw' && tokens[close + 1].value.toUpperCase() === 'AS') {
          explicit = names
          index = close + 1
        }
      }
      if (tokens[index]?.type === 'kw' && tokens[index].value.toUpperCase() === 'AS') index += 1
      if (!(tokens[index]?.type === 'punct' && tokens[index].value === '(')) return
      const open = index
      const close = matchingParen(tokens, open)
      ctes.push({ name, path: [...path], block, order: ctes.length, open, close, explicit })
      index = close + 1
      if (!(tokens[index]?.type === 'punct' && tokens[index].value === ',')) return
      index += 1
    }
  }
  const continueList = (start: number, path: number[], block: number): number => {
    let index = start
    let last = start - 1
    for (;;) {
      if (tokens[index]?.type === 'punct' && tokens[index].value === '(') {
        pendingDerived.push({ path, block, open: index })
        return index - 1
      }
      const taken = readTable(index, path, block)
      if (taken == null) return last
      last = taken
      index = taken + 1
      if (!(tokens[index]?.type === 'punct' && tokens[index].value === ',')) return last
      index += 1
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type === 'punct' && token.value === '(') {
      const group = nextGroup
      stack.push(nextGroup++)
      blocks.push(0)
      const opening = pendingDerived.find(item => item.open === i)
      if (opening) opening.group = group
      const cte = ctes.find(item => item.open === i)
      if (cte) cte.group = group
      continue
    }
    if (token.type === 'punct' && token.value === ')') {
      if (stack.length > 1) {
        stack.pop()
        blocks.pop()
      }
      const waiting = pendingDerived.at(-1)
      if (waiting && waiting.path.length === stack.length && waiting.path.every((item, index) => item === stack[index]) && waiting.block === blocks[blocks.length - 1]) {
        pendingDerived.pop()
        const aliased = readAlias(i)
        if (aliased.alias) add(undefined, aliased.alias, aliased.alias, stack, blocks[blocks.length - 1], { open: waiting.open, close: i, group: waiting.group })
        i = aliased.end
        if (tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === ',') i = continueList(i + 2, waiting.path, waiting.block)
      }
      continue
    }
    if (token.type === 'kw' && token.value.toUpperCase() === 'WITH') {
      noteCtes(i, [...stack], blocks[blocks.length - 1])
      continue
    }
    if (token.type === 'kw' && SET_OP_KEYWORDS.has(token.value.toUpperCase())) {
      blocks[blocks.length - 1] += 1
      continue
    }
    if (token.type !== 'kw' || !TABLE_SLOT_KEYWORDS.has(token.value.toUpperCase())) continue
    const keyword = token.value.toUpperCase()
    if (keyword === 'INTO' && tokens[i + 1]?.type === 'kw' && tokens[i + 1].value.toUpperCase() === 'FROM') continue
    if (keyword === 'UPDATE' && tokens[i - 1]?.value.toUpperCase() === 'FOR') continue
    const path = [...stack]
    const block = blocks[blocks.length - 1]
    if (JOIN_SLOT_KEYWORDS.has(keyword) && tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '(') {
      pendingDerived.push({ path, block, open: i + 1 })
      continue
    }
    i = Math.max(i, continueList(i + 1, path, block))
  }
  const childrenOf = (path: number[], group?: number) => {
    if (group == null) return []
    const expected = [...path, group]
    return tables.filter(item => item.path.length === expected.length && expected.every((part, index) => item.path[index] === part))
  }
  const bestCte = (item: ScopedTable) => ctes
    .filter(def => sameIdent(def.name, item.table) && isPathPrefix(def.path, item.path))
    .sort((left, right) => right.path.length - left.path.length || right.order - left.order)[0]
  const fill = (target: { path: number[]; columns?: { name: string }[]; star?: { database?: string; table: string }[] }, group: number | undefined, open: number, close: number, explicit?: { name: string }[]) => {
    if (explicit?.length) {
      target.columns = explicit
      return
    }
    const parsed = selectProjection(tokens, open, close)
    if (!parsed) return
    const columns = [...parsed.columns]
    const star: { database?: string; table: string }[] = []
    const absorb = (inner: ScopedTable) => {
      const projected = inner.columns?.length || inner.star?.length ? inner : bestCte(inner)
      if (projected?.columns?.length) columns.push(...projected.columns)
      if (projected?.star?.length) star.push(...projected.star)
      if (!projected?.columns?.length && !projected?.star?.length && !inner.source) star.push({ database: inner.database, table: inner.table })
    }
    for (const entry of parsed.star) {
      if (entry.table === '*') {
        for (const inner of childrenOf(target.path, group)) absorb(inner)
        continue
      }
      const inner = childrenOf(target.path, group).find(candidate => sameIdent(candidate.table, entry.table) || sameIdent(candidate.alias, entry.table))
      if (inner && (inner.columns?.length || inner.star?.length || inner.source || bestCte(inner))) absorb(inner)
      else star.push(entry)
    }
    if (columns.length) target.columns = columns
    if (star.length) target.star = star
  }
  for (const item of tables.filter(item => item.source).sort((left, right) => right.path.length - left.path.length)) {
    fill(item, item.source?.group, item.source!.open, item.source!.close, item.source!.explicit)
  }
  const orderedCtes = [...ctes].sort((left, right) => right.path.length - left.path.length || left.order - right.order)
  for (const cte of orderedCtes) {
    fill(cte, cte.group, cte.open, cte.close, cte.explicit)
    for (const item of tables) {
      if (item.source || item.columns?.length || item.star?.length) continue
      if (sameIdent(item.table, cte.name) && isPathPrefix(cte.path, item.path)) {
        if (cte.columns?.length) item.columns = cte.columns
        if (cte.star?.length) item.star = cte.star
      }
    }
  }
  return { tables, tokens }
}

/** offset 缺省时返回语句里出现过的全部表（预热缓存）；传入光标则按括号嵌套与 UNION 段过滤。 */
export function resolveScope(sql: string, dialect: Dialect = 'mysql', offset?: number): QueryScope {
  const collected = collectTables(sql, dialect)
  if (offset == null) return toScope(collected.tables)
  const cursor = scopeAt(collected.tokens, offset)
  return toScope(collected.tables.filter(item => inScopeAt(item, cursor)))
}

function lastKeyword(before: Token[]): Token | undefined {
  return [...before].reverse().find(token => token.type === 'kw')
}

function parenDepthAfter(tokens: Token[], from: number): number {
  let depth = 0
  for (const token of tokens) {
    if (token.from < from) continue
    if (token.type === 'punct' && token.value === '(') depth += 1
    if (token.type === 'punct' && token.value === ')') depth -= 1
  }
  return depth
}

export function analyzeContext(sql: string, offset: number, dialect: Dialect = 'mysql'): CompletionContext {
  const before = tokenize(sql, dialect).filter(token => token.to <= offset)
  const last = before.at(-1)
  const lastKw = lastKeyword(before)
  const keyword = lastKw?.value.toUpperCase() || ''
  const forUpdate = keyword === 'UPDATE' && before.filter(token => token.to <= (lastKw?.from || 0)).at(-1)?.value.toUpperCase() === 'FOR'
  const inTableSlot = TABLE_SLOT_KEYWORDS.has(keyword) && !forUpdate
  const allowViews = JOIN_SLOT_KEYWORDS.has(keyword)
  const dotted = last?.type === 'dot'
    ? before.at(-2)
    : last?.type === 'id' && before.at(-2)?.type === 'dot'
      ? before.at(-3)
      : undefined
  if (dotted && (dotted.type === 'id' || dotted.type === 'kw')) {
    if (inTableSlot) {
      const stillTyping = last?.type === 'dot' || (last?.type === 'id' && last.to === offset)
      if (stillTyping) return { type: 'table', qualifier: dotted.value, schemaQualifier: dotted.value, allowViews, lastKeyword: keyword }
    } else {
      const schemaToken = last?.type === 'dot' ? before.at(-4) : before.at(-5)
      const schemaDot = last?.type === 'dot' ? before.at(-3) : before.at(-4)
      return {
        type: 'column',
        qualifier: dotted.value,
        schemaQualifier: schemaDot?.type === 'dot' && schemaToken && (schemaToken.type === 'id' || schemaToken.type === 'kw') ? schemaToken.value : undefined,
        lastKeyword: keyword,
      }
    }
  }
  if (inTableSlot) {
    const after = before.filter(token => token.from >= (lastKw?.to || 0))
    const ids = after.filter(token => token.type === 'id' || token.type === 'dot')
    if (!ids.length || (ids.length === 1 && ids[0].type === 'id' && ids[0].to === offset)) return { type: 'table', allowViews, lastKeyword: keyword }
  }
  if (keyword === 'INTO' && lastKw && parenDepthAfter(before, lastKw.to) > 0) return { type: 'column', lastKeyword: keyword }
  if (EXPRESSION_KEYWORDS.includes(keyword)) return { type: 'expression', lastKeyword: keyword }
  return { type: 'keyword', lastKeyword: keyword || undefined }
}

/** 未输入标识符时不弹补全；FROM/JOIN 表位、点号后（库.表 / 别名.列）或显式 Ctrl+Space 除外。 */
export function shouldOfferCompletions(query: string, explicit: boolean, context: CompletionContext): boolean {
  if (explicit) return true
  if (query.replace(/^[`"]+|[`"]+$/g, '')) return true
  if (context.type === 'table') return true
  if (context.type === 'column' && context.lastKeyword === 'INTO') return true
  return !!context.qualifier && context.type === 'column'
}

function scoreText(query: string, text: string): number {
  if (!query) return 1
  if (text === query) return 20000
  if (text.startsWith(query)) return 15000 - Math.min(text.length - query.length, 500)
  const idx = text.indexOf(query)
  if (idx >= 0) {
    const boundary = /[._\s]/.test(text[idx - 1])
    return (boundary ? 12000 : 8000) - idx - Math.min(text.length - query.length, 500)
  }
  if (query.length < 2) return 0
  let from = 0, score = 3000, consecutive = 0
  for (const ch of query) {
    const found = text.indexOf(ch, from)
    if (found === -1) return 0
    if (found === from) consecutive += 1
    else consecutive = 0
    if (found === 0 || /[._\s]/.test(text[found - 1])) score += 80
    score += consecutive * 12
    score -= found - from
    from = found + 1
  }
  return Math.max(1, score - Math.min(text.length - query.length, 400))
}

/** 关闭 CodeMirror 默认首字母过滤后，用前缀、连续子串、子序列打分；无输入时全部保留。 */
export function suggestionScore(query: string, item: Suggestion): number {
  const q = query.replace(/^[`"]+|[`"]+$/g, '').toLocaleLowerCase()
  if (!q) return 1
  if (item.kind === 'keyword' && q.length < 2) {
    const parts = item.label.toLocaleLowerCase().split(/[\s.]+/).filter(Boolean)
    if (!parts.some(part => part.startsWith(q))) return 0
  }
  const label = item.label.toLocaleLowerCase()
  const insert = item.insert.toLocaleLowerCase()
  const column = insert.includes('.') ? insert.slice(insert.lastIndexOf('.') + 1) : label
  let best = Math.max(scoreText(q, label), scoreText(q, insert), scoreText(q, column))
  for (const part of label.split(/[\s.]+/)) best = Math.max(best, scoreText(q, part))
  return best
}

export function suggestionMatches(query: string, item: Suggestion): boolean {
  return suggestionScore(query, item) > 0
}

function finish(suggestions: Suggestion[], pending: string[]): CompletionResult {
  return { suggestions, pending: [...new Set(pending)] }
}

function columnSuggestion(column: CatalogColumn, insert: string, detail: string | undefined, boost: number): Suggestion {
  return { label: insert.includes('.') ? insert : column.name, insert, kind: 'column', detail, boost }
}

function suggestTables(tables: CatalogTable[], allowViews: boolean): Suggestion[] {
  return tables
    .filter(item => allowViews || item.kind === 'table')
    .map(item => ({ label: item.name, insert: item.name, kind: 'table' as const, boost: 80 }))
}

function suggestQualifiedColumns(input: {
  context: CompletionContext
  scope: QueryScope
  schema: string
  tables: CatalogTable[]
  columnsOf(table: string, database?: string): CatalogColumn[] | undefined
  resolveTable(name: string): string
  pending: string[]
  projected(ref: TableRef): CatalogColumn[] | undefined
}): CompletionResult {
  const { context, scope, schema, tables, columnsOf, resolveTable, pending, projected } = input
  const qualifier = context.qualifier || ''
  const empty = () => finish([], pending)
  const scoped = scope.aliases[qualifier.toLowerCase()]
  if (!scoped) return empty()
  const table = resolveTable(scoped)
  const ref = scope.tables.find(item => sameIdent(item.table, table) || sameIdent(item.alias, qualifier))
  if (context.schemaQualifier && !sameIdent(context.schemaQualifier, ref?.database || schema)) return empty()
  const fromProjection = ref ? projected(ref) : undefined
  if (fromProjection) return finish(fromProjection.map(column => columnSuggestion(column, column.name, column.type, 120)), pending)
  const database = ref?.database && !sameIdent(ref.database, schema) ? ref.database : undefined
  const columns = columnsOf(table, database)
  if (!columns) {
    if (!database && tables.some(item => sameIdent(item.name, table))) pending.push(table)
    return empty()
  }
  return finish(columns.map(column => columnSuggestion(column, column.name, column.type, 120)), pending)
}

/** 新候选写成函数，从下面对应分支调用。不要新开 completion source，不要复制打分。 */
export function buildCompletion(input: {
  context: CompletionContext
  scope: QueryScope
  schema: string
  dialect?: Dialect
  tables: CatalogTable[]
  columnsOf(table: string, database?: string): CatalogColumn[] | undefined
}): CompletionResult {
  const { context, scope, schema, tables, columnsOf } = input
  const dialect = input.dialect || 'mysql'
  const pending: string[] = []
  const inCurrentSchema = (name?: string) => !name || sameIdent(name, schema)
  const resolveTable = (name: string) => tables.find(item => item.name.toLowerCase() === name.toLowerCase())?.name || name
  const knownTable = (name: string) => tables.some(item => sameIdent(item.name, name))
  const projected = (ref: TableRef): CatalogColumn[] | undefined => {
    if (!ref.columns?.length && !ref.star?.length) return undefined
    const columns: CatalogColumn[] = [...(ref.columns || [])]
    for (const entry of ref.star || []) {
      const found = columnsOf(entry.table, entry.database)
      if (!found) {
        if ((!entry.database || sameIdent(entry.database, schema)) && knownTable(entry.table)) pending.push(entry.table)
        continue
      }
      columns.push(...found)
    }
    return columns
  }
  if (context.type === 'table') {
    if (!inCurrentSchema(context.schemaQualifier || context.qualifier)) return finish([], pending)
    return finish(suggestTables(tables, !!context.allowViews), pending)
  }
  if (context.type === 'keyword' && !context.qualifier) {
    return finish([...suggestTables(tables, false), ...keywordSuggestions(40, dialect)], pending)
  }
  const insertList = context.type === 'column' && context.lastKeyword === 'INTO' && !context.qualifier
  const columnsFor = (ref: TableRef) => {
    const fromProjection = projected(ref)
    let columns = fromProjection
    if (!columns) {
      const foreign = ref.database && !sameIdent(ref.database, schema) ? ref.database : undefined
      const resolved = resolveTable(ref.table)
      columns = columnsOf(resolved, foreign) || []
      if (!columns.length) {
        if (!foreign && knownTable(resolved)) pending.push(resolved)
        return []
      }
    }
    const prefix = insertList ? '' : ref.alias || (scope.tables.length > 1 ? ref.table : '')
    return columns.map(column => columnSuggestion(
      column,
      context.qualifier ? column.name : prefix ? `${prefix}.${column.name}` : column.name,
      prefix ? `${prefix} · ${column.type || ''}`.trim() : column.type,
      100,
    ))
  }
  if (context.qualifier) {
    return suggestQualifiedColumns({ context, scope, schema, tables, columnsOf, resolveTable, pending, projected })
  }
  if (context.type === 'expression' || context.type === 'column') {
    const scoped = scope.tables.length ? scope.tables.flatMap(ref => columnsFor(ref)) : []
    const keywords = context.type === 'expression' ? expressionKeywords(context.lastKeyword, dialect) : []
    return finish([...scoped, ...keywords], pending)
  }
  return finish(keywordSuggestions(30, dialect), pending)
}

export function buildSuggestions(input: Parameters<typeof buildCompletion>[0]): Suggestion[] {
  return buildCompletion(input).suggestions
}

function keywordSuggestions(boost: number, dialect: Dialect): Suggestion[] {
  const extra = dialectCapabilities(dialect).paginationKeywords
  return ['SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'GROUP BY', 'ORDER BY', 'HAVING', 'INSERT', 'INTO', 'UPDATE', 'SET', 'DELETE', 'UNION', 'ON', 'VALUES', 'DISTINCT', ...extra, 'AND', 'OR', 'IN', 'LIKE', 'IS NULL', 'IS NOT NULL', 'BETWEEN']
    .map(label => ({ label, insert: opensTableSlot(label) ? `${label} ` : label, kind: 'keyword' as const, boost }))
}

function expressionKeywords(lastKeyword: string | undefined, dialect: Dialect): Suggestion[] {
  if (lastKeyword === 'SELECT' || lastKeyword === 'DISTINCT') {
    return keywordSuggestions(45, dialect).filter(item => item.label === 'FROM' || item.label === 'DISTINCT')
  }
  if (lastKeyword === 'SET' || lastKeyword === 'BY') return []
  return keywordSuggestions(20, dialect).filter(item => WHERE_KEYWORDS.includes(item.label) || item.label === 'AND' || item.label === 'OR')
}

export function opensTableSlot(label: string): boolean {
  const last = label.trim().split(/\s+/).pop()?.toUpperCase()
  return !!last && TABLE_SLOT_KEYWORDS.has(last)
}

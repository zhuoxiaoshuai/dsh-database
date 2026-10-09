import { completionStatus, currentCompletions, startCompletion, type CompletionContext } from '@codemirror/autocomplete'
import { skipRegion } from '../../../shared/sql-lex.ts'
import type { EditorView } from '@codemirror/view'
import type { Connection, Dialect } from '../../../shared/workbench.ts'
import type { SchemaCache } from '../../schema/schema-cache.ts'
import { analyzeContext, buildCompletion, isInsideCommentOrLiteral, locateStatement, resolveScope, shouldOfferCompletions, suggestionMatches, suggestionScore, type QueryScope, type Suggestion } from './engine.ts'

export { opensTableSlot } from './engine.ts'

const IDENT_PREFIX = /[`"\p{L}\p{N}_$#]*$/u

/** One range for filtering and replacing, including the part to the right of the caret. */
export function completionIdentifierRange(text: string, pos: number, dialect: Dialect) {
  for (let index = 0; index < text.length;) {
    const region = skipRegion(text, index, dialect)
    if (region.kind === 'quotedIdent' && pos > index && pos <= region.index) {
      return { from: index, to: region.index, typed: text.slice(index + 1, region.closed && pos === region.index ? pos - 1 : pos).replaceAll(text[index] + text[index], text[index]), quote: text[index] }
    }
    index = region.kind ? Math.max(index + 1, region.index) : index + 1
  }
  const prefix = text.slice(0, pos).match(IDENT_PREFIX)?.[0] || ''
  const suffix = text.slice(pos).match(/^[\p{L}\p{N}_$#]*/u)?.[0] || ''
  return { from: pos - prefix.length, to: pos + suffix.length, typed: prefix, quote: '' }
}

export type CompletionLive = {
  dialect: Dialect
  schema: string
  connection?: Connection
  cache?: SchemaCache
}

const EXPLICIT_WAIT_MS = 500
const EXPLICIT_WAIT_TABLES = 4

type CompletionOption = { label: string; apply: string; type?: string; detail?: string; boost: number }

const COMPLETION_ICON: Record<string, string> = { table: 'namespace', column: 'property', keyword: 'keyword' }

function ensureMetadata(live: CompletionLive, scope: QueryScope): void {
  if (!live.connection || !live.cache || !live.schema) return
  live.cache.warmSchema(live.connection, live.schema)
  const grouped = new Map<string, string[]>()
  const add = (schemaName: string | undefined, table: string) => {
    if (!schemaName || !table || table === '*') return
    const list = grouped.get(schemaName) || []
    list.push(table)
    grouped.set(schemaName, list)
  }
  for (const ref of scope.tables) {
    if (ref.columns?.length || ref.star?.length) {
      for (const entry of ref.star || []) add(entry.database || live.schema, entry.table)
      continue
    }
    add(ref.database || live.schema, ref.table)
  }
  for (const [schemaName, names] of grouped) live.cache.prefetchColumns(live.connection, schemaName, names)
}

export function ensureCompletionMetadata(live: CompletionLive, sql: string): void {
  ensureMetadata(live, resolveScope(sql, live.dialect))
}

function statementAt(sql: string, pos: number, dialect: Dialect) {
  const statement = locateStatement(sql, pos, dialect)
  return { statement, offset: pos - statement.start }
}

function rankSuggestions(typed: string, suggestions: Suggestion[]): CompletionOption[] {
  return suggestions
    .filter(item => suggestionMatches(typed, item))
    .sort((a, b) => suggestionScore(typed, b) - suggestionScore(typed, a) || b.boost - a.boost || a.label.localeCompare(b.label))
    .map(item => ({
      label: item.label, apply: item.insert, type: COMPLETION_ICON[item.kind] || item.kind, detail: item.detail, boost: item.boost,
    }))
}

function computeFromScope(live: CompletionLive, statementSql: string, offset: number, typed: string, explicit: boolean, scope: QueryScope): { options: CompletionOption[]; pending: string[] } | null {
  const analyzed = analyzeContext(statementSql, offset, live.dialect)
  if (!shouldOfferCompletions(typed, explicit, analyzed)) return null
  const tables = live.connection && live.cache
    ? (live.cache.tablesSnapshot(live.connection, live.schema) || []).map(item => ({ name: item.name, kind: item.kind, comment: item.comment }))
    : []
  const { suggestions, pending } = buildCompletion({
    context: analyzed,
    scope,
    schema: live.schema,
    dialect: live.dialect,
    tables,
    columnsOf: (name, database) => {
      if (!live.connection || !live.cache) return undefined
      const schemaName = database || live.schema
      if (!schemaName) return undefined
      const detail = live.cache.detailSnapshot(live.connection, schemaName, name)
      return detail?.columns?.map(column => ({ name: String(column.name || ''), type: String(column.type || ''), comment: String(column.comment || '') }))
    },
  })
  return { options: rankSuggestions(typed, suggestions), pending }
}

export function computeCompletion(live: CompletionLive, sql: string, pos: number, typed: string, explicit: boolean): { options: CompletionOption[]; pending: string[] } | null {
  const statement = locateStatement(sql, pos, live.dialect)
  const offset = pos - statement.start
  return computeFromScope(live, statement.sql, offset, typed, explicit, resolveScope(statement.sql, live.dialect, offset))
}

export function completionOptionsFromCache(live: CompletionLive, sql: string, pos: number, typed: string, explicit: boolean) {
  const computed = computeCompletion(live, sql, pos, typed, explicit)
  return computed && computed.options.length ? computed.options : null
}

function listedOptions(live: CompletionLive, sql: string, pos: number): CompletionOption[] {
  const typed = completionIdentifierRange(sql, pos, live.dialect).typed
  const computed = computeCompletion(live, sql, pos, typed, false)
  if (!computed) return []
  return computed.options
}

function optionFingerprint(options: readonly { label: string; apply?: unknown; type?: string; detail?: string }[]): string {
  return options.map(item => `${item.label}\0${typeof item.apply === 'string' ? item.apply : ''}\0${item.type || ''}\0${item.detail || ''}`).join('\n')
}

export function completionOptionFingerprint(live: CompletionLive, sql: string, pos: number): string {
  return optionFingerprint(listedOptions(live, sql, pos))
}

export type CompletionRefreshSeen = { tables: number; intoColumns: string; fingerprint?: string }

/** 列表已开时指纹不变不重启；未开时只在表清单 0→N 或 INSERT 列第一次就绪时打开。 */
export function completionRefreshAction(input: {
  focused: boolean
  live: CompletionLive
  sql: string
  pos: number
  status: 'active' | 'pending' | null
  openFingerprint: string
  seen: CompletionRefreshSeen
}): { action: 'start' | 'skip'; seen: CompletionRefreshSeen } {
  const { focused, live, sql, pos, status, openFingerprint, seen } = input
  if (!focused || !live.connection || !live.cache) return { action: 'skip', seen }
  if (isInsideCommentOrLiteral(sql, pos, live.dialect)) return { action: 'skip', seen }
  if (status === 'active' || status === 'pending') {
    const next = completionOptionFingerprint(live, sql, pos)
    return { action: next === openFingerprint ? 'skip' : 'start', seen }
  }
  const { statement, offset } = statementAt(sql, pos, live.dialect)
  const analyzed = analyzeContext(statement.sql, offset, live.dialect)
  const next = { ...seen }
  if (analyzed.type === 'table') {
    const count = live.cache.tablesSnapshot(live.connection, live.schema)?.length || 0
    const prev = seen.tables
    next.tables = count
    return { action: prev === 0 && count > 0 ? 'start' : 'skip', seen: next }
  }
  if (analyzed.type === 'column' && analyzed.lastKeyword === 'INTO') {
    const scope = resolveScope(statement.sql, live.dialect, offset)
    const ready = scope.tables
      .filter(ref => live.cache?.detailSnapshot(live.connection!, ref.database || live.schema, ref.table)?.columns?.length)
      .map(ref => ref.table.toLowerCase())
      .sort()
      .join('\0')
    const prev = seen.intoColumns
    next.intoColumns = ready
    return { action: !prev && ready ? 'start' : 'skip', seen: next }
  }
  const fingerprint = completionOptionFingerprint(live, sql, pos)
  return { action: seen.fingerprint !== undefined && fingerprint && seen.fingerprint !== fingerprint ? 'start' : 'skip', seen: { ...seen, fingerprint } }
}

export function createEditorCompletionRefresh() {
  let seen: CompletionRefreshSeen = { tables: -1, intoColumns: '' }
  let shown = '', dismissed = '', position = ''
  const refresh = (view: EditorView, live: CompletionLive) => {
    const sql = view.state.doc.toString()
    const pos = view.state.selection.main.head
    const at = `${sql}\0${pos}`
    if (at !== position) { position = at; dismissed = ''; seen = { tables: -1, intoColumns: '', fingerprint: '' }; shown = '' }
    if (dismissed === at || view.composing) return
    const listed = currentCompletions(view.state)
    const listedFingerprint = optionFingerprint(listed)
    // pending 时 open.disabled，currentCompletions 是空的，用上次指纹避免预热 emit 反复 startCompletion。
    const openFingerprint = listed.length ? listedFingerprint : shown
    const result = completionRefreshAction({
      focused: view.hasFocus,
      live,
      sql,
      pos,
      status: completionStatus(view.state),
      openFingerprint,
      seen,
    })
    seen = result.seen
    if (listed.length) shown = listedFingerprint
    if (result.action === 'start') {
      shown = completionOptionFingerprint(live, sql, pos)
      startCompletion(view)
    }
  }
  refresh.observe = (view: EditorView, live: CompletionLive) => {
    const sql = view.state.doc.toString(), pos = view.state.selection.main.head
    position = `${sql}\0${pos}`; dismissed = ''; shown = ''
    seen = { tables: live.connection && live.cache ? live.cache.tablesSnapshot(live.connection, live.schema)?.length || 0 : -1, intoColumns: '', fingerprint: completionOptionFingerprint(live, sql, pos) }
  }
  refresh.dismiss = (view: EditorView) => { dismissed = `${view.state.doc.toString()}\0${view.state.selection.main.head}` }
  return refresh
}

async function waitForColumns(live: CompletionLive, tables: string[]): Promise<void> {
  const cache = live.cache, connection = live.connection
  if (!cache || !connection || !live.schema) return
  const loads = tables.slice(0, EXPLICIT_WAIT_TABLES).map(name => cache.loadTable(connection, live.schema, name, { batched: true }).then(() => {}).catch(() => {}))
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, EXPLICIT_WAIT_MS) })
  try {
    await Promise.race([Promise.all(loads).then(() => {}), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createSqlCompletionSource(getLive: () => CompletionLive) {
  return (context: CompletionContext) => {
    const live = getLive(), text = context.state.doc.toString()
    if (context.aborted || isInsideCommentOrLiteral(text, context.pos, live.dialect)) return null
    const { statement, offset } = statementAt(text, context.pos, live.dialect)
    ensureMetadata(live, resolveScope(statement.sql, live.dialect))
    const scope = resolveScope(statement.sql, live.dialect, offset)
    const word = completionIdentifierRange(text, context.pos, live.dialect)
    const compute = () => {
      if (context.aborted) return null
      const computed = computeFromScope(live, statement.sql, offset, word.typed, context.explicit, scope)
      if (!computed?.options.length) return null
      const options = word.quote ? computed.options.map(item => ({ ...item, apply: item.type === 'keyword' ? item.apply : word.quote + item.apply.replaceAll(word.quote, word.quote + word.quote) + word.quote })) : computed.options
      return { from: word.from, to: word.to, options, filter: false }
    }
    const computed = computeFromScope(live, statement.sql, offset, word.typed, context.explicit, scope)
    // Warm metadata is synchronous, so an available list does not become pending again.
    if (context.explicit && computed?.pending.length) return waitForColumns(live, computed.pending).then(compute)
    return compute()
  }
}

export function shouldRefreshEditorCompletions(live: CompletionLive, sql: string, pos: number, focused: boolean): boolean {
  if (!focused || !live.connection || !live.cache) return false
  if (isInsideCommentOrLiteral(sql, pos, live.dialect)) return false
  const { statement, offset } = statementAt(sql, pos, live.dialect)
  const analyzed = analyzeContext(statement.sql, offset, live.dialect)
  const prefix = statement.sql.slice(0, offset).match(IDENT_PREFIX)?.[0] || ''
  return shouldOfferCompletions(prefix, analyzed.type === 'table' || !!analyzed.qualifier || (analyzed.type === 'column' && analyzed.lastKeyword === 'INTO'), analyzed)
}

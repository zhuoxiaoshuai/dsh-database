import type { Dialect } from './workbench.ts'
import { dialectCapabilities } from './dialect-capabilities.ts'

type SqlRegionKind = 'comment' | 'string' | 'quotedIdent'

function skipQQuote(sql: string, start: number): { index: number; skipped: boolean } {
  const q = sql[start]
  if ((q !== 'q' && q !== 'Q') || sql[start + 1] !== "'") return { index: start, skipped: false }
  const opener = sql[start + 2]
  if (!opener) return { index: sql.length, skipped: true }
  const closer = opener === '[' ? ']' : opener === '{' ? '}' : opener === '(' ? ')' : opener === '<' ? '>' : opener
  let i = start + 3
  while (i < sql.length) {
    if (sql[i] === closer && sql[i + 1] === "'") return { index: i + 2, skipped: true }
    i += 1
  }
  return { index: sql.length, skipped: true }
}

export function skipRegion(sql: string, start: number, dialect: Dialect = 'mysql'): { index: number; kind: SqlRegionKind | null; closed: boolean } {
  let i = start
  const source = dialectCapabilities(dialect)
  if (sql.startsWith('--', i)) {
    if (!source.doubleDashNeedsSpace || i + 2 >= sql.length || /\s/.test(sql[i + 2])) {
      const end = sql.indexOf('\n', i)
      return { index: end === -1 ? sql.length : end + 1, kind: 'comment', closed: end !== -1 }
    }
  }
  if (source.supportsHashComment && sql[i] === '#') {
    const end = sql.indexOf('\n', i)
    return { index: end === -1 ? sql.length : end + 1, kind: 'comment', closed: end !== -1 }
  }
  if (sql.startsWith('/*', i)) {
    const end = sql.indexOf('*/', i + 2)
    return { index: end === -1 ? sql.length : end + 2, kind: 'comment', closed: end !== -1 }
  }
  if (source.supportsQQuote) {
    const quoted = skipQQuote(sql, i)
    if (quoted.skipped) return { index: quoted.index, kind: 'string', closed: quoted.index < sql.length }
  }
  const quote = sql[i]
  if (quote === "'" || quote === '"' || quote === '`') {
    const identQuote = source.identifierQuote
    const kind: SqlRegionKind = quote === "'" || quote !== identQuote ? 'string' : 'quotedIdent'
    i += 1
    while (i < sql.length) {
      if (kind === 'string' && sql[i] === '\\' && quote !== '`') { i += 2; continue }
      if (sql[i] === quote) {
        if (sql[i + 1] === quote) { i += 2; continue }
        return { index: i + 1, kind, closed: true }
      }
      i += 1
    }
    return { index: sql.length, kind, closed: false }
  }
  return { index: start, kind: null, closed: true }
}

function skip(sql: string, start: number, dialect: Dialect = 'mysql'): { index: number; skipped: boolean } {
  const region = skipRegion(sql, start, dialect)
  return { index: region.index, skipped: region.kind !== null }
}

export function isInsideCommentOrLiteral(sql: string, offset: number, dialect: Dialect = 'mysql'): boolean {
  const point = Math.max(0, Math.min(offset, sql.length))
  let i = 0
  while (i < sql.length) {
    const region = skipRegion(sql, i, dialect)
    if (region.kind === null) { i += 1; continue }
    if (region.kind !== 'quotedIdent' && point > i && (point < region.index || !region.closed)) return true
    i = Math.max(region.index, i + 1)
  }
  return false
}

export type StatementRange = { start: number; end: number; sql: string }

export function enumerateStatements(sql: string, dialect: Dialect = 'mysql'): StatementRange[] {
  const ranges: StatementRange[] = []
  let start = 0, i = 0
  while (i < sql.length) {
    const skipped = skip(sql, i, dialect)
    if (skipped.skipped) { i = skipped.index; continue }
    if (sql[i] === ';') {
      ranges.push({ start, end: i, sql: sql.slice(start, i) })
      start = i + 1
    }
    i += 1
  }
  ranges.push({ start, end: sql.length, sql: sql.slice(start) })
  return ranges
}

export function locateStatement(sql: string, offset: number, dialect: Dialect = 'mysql'): StatementRange {
  const ranges = enumerateStatements(sql, dialect)
  const point = Math.max(0, Math.min(offset, sql.length))
  return ranges.find(range => point >= range.start && point <= range.end) || ranges.at(-1) || { start: 0, end: sql.length, sql }
}

function leadKind(sql: string): string {
  let text = sql.trim()
  for (;;) {
    const next = text.replace(/^--[^\n]*(?:\r?\n|$)/, '').replace(/^#[^\n]*(?:\r?\n|$)/, '').replace(/^\/\*[\s\S]*?\*\//, '').trim()
    if (next === text) return text
    text = next
  }
}

/**
 * Split a script into the statements the Host policy authorizes.
 *
 * Deliberately not `enumerateStatements`: it keeps the historical Host region
 * rules (`--` and `#` always open a comment, backslash escapes only single
 * quotes, no q-quotes) so the statement count reaching authorization never
 * changes. Comment-only segments are dropped and leading comments stay attached.
 */
export function splitStatements(sql: string): string[] {
  const text = String(sql || '')
  const parts: string[] = []
  let i = 0, start = 0, started = false
  const n = text.length
  const emit = (end: number) => {
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

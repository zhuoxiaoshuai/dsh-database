import { format, mysql, plsql } from 'sql-formatter'
import type { Dialect } from './workbench.ts'
import { dialectCapabilities } from './dialect-capabilities.ts'
import { SQL_FIELD_MAX_LENGTH } from './limits.ts'
import { skipRegion } from './sql-lex.ts'

export type SqlFormatRange = { from: number; to: number }
export type SqlFormatResult = SqlFormatRange & { insert: string; text: string; kind: 'sql' | 'values' }

const bareValue = /^[\p{L}\p{N}_]+$/u
const tokenChar = /[\p{L}\p{N}\p{M}_$#]/u
const reserved = new Map<string, Set<string>>()

function reservedWords(dialect: Dialect): Set<string> {
  const language = dialectCapabilities(dialect).formatterLanguage
  let words = reserved.get(language)
  if (!words) {
    const options = (language === 'mysql' ? mysql : plsql).tokenizerOptions
    words = new Set(Object.entries(options).filter(([key]) => key.startsWith('reserved'))
      .flatMap(([, phrases]) => (phrases as string[]).flatMap(phrase => phrase.toUpperCase().split(/\s+/))))
    reserved.set(language, words)
  }
  return words
}

export function parseSqlFormatRange(value: unknown, length: number): SqlFormatRange | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('格式化选区无效。')
  const range = value as Record<string, unknown>
  if (Object.keys(range).length !== 2 || !Object.hasOwn(range, 'from') || !Object.hasOwn(range, 'to')
    || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)
    || (range.from as number) < 0 || (range.to as number) > length || (range.from as number) >= (range.to as number)) {
    throw new Error('格式化选区无效。')
  }
  return { from: range.from as number, to: range.to as number }
}

function assertSelectionBoundaries(text: string, range: SqlFormatRange, dialect: Dialect): void {
  for (let i = 0; i < text.length;) {
    const region = skipRegion(text, i, dialect)
    if (region.kind === null) { i += 1; continue }
    if ([range.from, range.to].some(point => point > i && point < region.index)) {
      throw new Error('选区不能截断字符串、注释或引用标识符，请重新选择。')
    }
    i = Math.max(region.index, i + 1)
  }
  for (const point of [range.from, range.to]) {
    // CodeMirror offsets are UTF-16; examining whole code points also catches split surrogate pairs.
    const before = Array.from(text.slice(0, point)).at(-1) || ''
    const after = Array.from(text.slice(point))[0] || ''
    if ((tokenChar.test(before) && tokenChar.test(after))
      || (point > 0 && /[\uD800-\uDBFF]/.test(text[point - 1]) && /[\uDC00-\uDFFF]/.test(text[point] || ''))) {
      throw new Error('选区不能截断 SQL 词元，请重新选择。')
    }
  }
}

function convertValues(text: string, dialect: Dialect): string | undefined {
  const wrapped = text.startsWith('(') && text.endsWith(')')
  const body = wrapped ? text.slice(1, -1).trim() : text
  if (!/^[\p{L}\p{N}_,\s]+$/u.test(body)) return undefined
  const values = body.split(/[,\s]+/u).filter(Boolean)
  if (values.length < 2 || values.some(value => !bareValue.test(value) || reservedWords(dialect).has(value.toUpperCase()))) return undefined
  // A comma between every pair means this is an existing SQL list, including identifiers/numbers.
  const tokens = [...body.matchAll(/[\p{L}\p{N}_]+/gu)]
  const missingComma = tokens.slice(1).some((token, index) => {
    const previous = tokens[index]
    return !body.slice(previous.index! + previous[0].length, token.index!).includes(',')
  })
  if (!missingComma) return undefined
  const result = values.map(value => `'${value}'`).join(', ')
  return wrapped ? `(${result})` : result
}

/** Deterministic replacement shared by the editor and the authoritative Host validation. */
export function prepareSqlFormat(text: string, dialect: Dialect, selection?: SqlFormatRange): SqlFormatResult {
  const range = parseSqlFormatRange(selection, text.length) || { from: 0, to: text.length }
  const source = text.slice(range.from, range.to)
  if (!source.trim()) return { ...range, insert: source, text, kind: 'sql' }
  if (selection) assertSelectionBoundaries(text, range, dialect)
  const leading = selection ? source.match(/^\s*/u)![0] : ''
  const trailing = selection ? source.match(/\s*$/u)![0] : ''
  const body = selection ? source.trim() : source
  const values = selection ? convertValues(body, dialect) : undefined
  let insert: string
  try { insert = leading + (values ?? format(body, { language: dialectCapabilities(dialect).formatterLanguage })) + trailing }
  catch { throw new Error('无法格式化当前 SQL，请检查语法或选区。') }
  const next = text.slice(0, range.from) + insert + text.slice(range.to)
  if (next.length > SQL_FIELD_MAX_LENGTH) throw new Error('格式化结果超过文档长度上限。')
  return { ...range, insert, text: next, kind: values === undefined ? 'sql' : 'values' }
}

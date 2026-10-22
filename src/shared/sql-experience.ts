import type { Dialect } from './workbench.ts'
import { skipRegion } from './sql-lex.ts'
import { prepareSqlFormat } from './sql-format.ts'

/** Drop comments; keep string and identifier literals so tidy cannot change values. */
export function stripSqlComments(sql: string, dialect: Dialect): string {
  let out = ''
  for (let i = 0; i < sql.length;) {
    const region = skipRegion(sql, i, dialect)
    if (region.kind === 'comment') {
      out += sql.slice(i, region.index).includes('\n') ? '\n' : ' '
      i = Math.max(region.index, i + 1)
      continue
    }
    if (region.kind === 'string' || region.kind === 'quotedIdent') {
      out += sql.slice(i, region.index)
      i = Math.max(region.index, i + 1)
      continue
    }
    out += sql[i]
    i += 1
  }
  return out.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
}

export function sqlExecutableCore(sql: string, dialect: Dialect): string {
  return stripSqlComments(sql, dialect).replace(/\s+/g, ' ').trim().toLowerCase()
}

/** True when `next` only adds comments or formatting to `original`. */
export function sameSqlExperience(original: string, next: string, dialect: Dialect): boolean {
  const left = sqlExecutableCore(original, dialect)
  const right = sqlExecutableCore(next, dialect)
  if (!left || !right) return false
  if (left === right) return true
  try {
    const formattedLeft = sqlExecutableCore(prepareSqlFormat(stripSqlComments(original, dialect), dialect).text, dialect)
    const formattedRight = sqlExecutableCore(prepareSqlFormat(stripSqlComments(next, dialect), dialect).text, dialect)
    return !!formattedLeft && formattedLeft === formattedRight
  } catch {
    return false
  }
}

export function formatSqlExperience(sql: string, dialect: Dialect): string {
  try {
    const formatted = prepareSqlFormat(sql, dialect).text
    return sameSqlExperience(sql, formatted, dialect) ? formatted : sql
  } catch {
    return sql
  }
}

import { splitStatements } from '../../shared/sql-lex.ts'

export { splitStatements }

/** Parser could not prove a single read or DML statement. The database decides. */
export function unverifiedStatement(sql) {
  return { kind: 'write', tables: [], targets: [], references: [], aliases: [], sql: String(sql || '').trim().replace(/;\s*$/, '') }
}

export function aliasesOf(value) {
  return Array.isArray(value) ? value : value ? [...value] : []
}

export const recordTable = (set, ref) => {
  const table = String(ref?.table || '')
  if (table) set.add(table)
}

// 通用输入校验：非空、大小、业务库。
export function guard(sql, schema) {
  if (typeof sql !== 'string' || !sql.trim() || Buffer.byteLength(sql) > 16000 || typeof schema !== 'string' || !schema || schema.length > 128) throw new Error('请选择数据库，并输入不超过 16 KiB 的 SQL。')
}


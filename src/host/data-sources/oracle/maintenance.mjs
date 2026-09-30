import { MaintenanceError } from '../maintenance-error.mjs'
import { oracleIdentityMatches } from './connection.mjs'
import { applyOracleTemporalSession } from './temporal.mjs'
import { read as readCatalog } from './catalog.mjs'
import { oracleDialect, sql } from './driver.mjs'

export async function inspect(connection, schema, table, allowMissing = false) {
  const target = await connection.execute("SELECT table_name FROM all_tables WHERE owner=:1 AND table_name=:2 AND temporary='N' AND nested='NO' AND secondary='N'", [schema, table])
  if (!target.rows.length && !allowMissing) throw new MaintenanceError('目标不是已验证的普通表。')
  return readCatalog(connection, { kind: 'table', schema, table })
}

export async function privileges(connection, schema, table, credentials) {
  const wanted = ['INSERT', 'UPDATE', 'DELETE']
  const allowAll = { insert: true, update: true, delete: true }
  const owner = String(schema).toUpperCase()
  const current = String(credentials.user || credentials.username || '').toUpperCase()
  if (current && current === owner) return allowAll
  const result = await connection.execute(
    "SELECT privilege FROM all_tab_privs WHERE owner=:1 AND table_name=:2 AND grantee IN (USER,'PUBLIC') AND privilege IN ('INSERT','UPDATE','DELETE')",
    [owner, String(table).toUpperCase()],
  )
  const allowed = new Set((result.rows || []).map(row => String(Array.isArray(row) ? row[0] : row.PRIVILEGE || row.privilege).toUpperCase()))
  if (![...allowed].some(privilege => wanted.includes(privilege))) return allowAll
  return { insert: allowed.has('INSERT'), update: allowed.has('UPDATE'), delete: allowed.has('DELETE') }
}

export async function dependencies(db, schema, table, creating = false) {
  if (creating) return []
  const dependent = await db.execute("SELECT name,type FROM dba_dependencies WHERE referenced_owner=:1 AND referenced_name=:2 AND type NOT IN ('INDEX') FETCH FIRST 1 ROWS ONLY", [schema, table])
  const foreign = await db.execute('SELECT c.constraint_name FROM dba_constraints c JOIN dba_constraints p ON p.owner=c.r_owner AND p.constraint_name=c.r_constraint_name WHERE p.owner=:1 AND p.table_name=:2 FETCH FIRST 1 ROWS ONLY', [schema, table])
  if (dependent.rows.length || foreign.rows.length) throw new MaintenanceError('目标存在已声明依赖，暂不开放结构维护。')
  return []
}

export const sqlMode = async () => ''

export async function verifyIdentity(db, credentials) {
  if (!await oracleIdentityMatches(db, credentials.identity)) throw new MaintenanceError('数据库实例或账号已变化，审批失效。')
}

export async function prepareDml(db, plan) {
  const target = `${sql.quote(plan.schema)}.${sql.quote(plan.table)}`
  await db.execute(`LOCK TABLE ${target} IN ROW EXCLUSIVE MODE NOWAIT`)
}

export async function executeDml(db, plan) {
  const result = await db.execute(plan.sql, plan.params, { autoCommit: false })
  return Number(result.rowsAffected)
}

export const commit = db => db.commit()
export const rollback = db => db.rollback()

export async function prepareDdl(db) { await db.execute('ALTER SESSION SET DDL_LOCK_TIMEOUT=5') }
export const readDdl = (db, schema, table) => readCatalog(db, { kind: 'table', schema, table })
export const executeDdl = (db, text) => db.execute(text)
export async function peekDdl(db, schema, table) {
  return (await db.execute(`SELECT 1 FROM ${sql.quote(schema)}.${sql.quote(table)} FETCH FIRST 1 ROWS ONLY`)).rows
}

export async function open(credentials) {
  const db = await oracleDialect.openMaintenance(credentials)
  await applyOracleTemporalSession(db)
  return db
}
export const close = db => oracleDialect.destroy(db)
export const isUncertainDdlError = error => /TIMEOUT|CONNECTION|ECONN|EPIPE|NJS-0(03|40|500)|DPI-|ORA-031|ORA-121|ORA-125/i.test(String(error?.code || ''))

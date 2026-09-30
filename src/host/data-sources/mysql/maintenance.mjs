import { MaintenanceError } from '../maintenance-error.mjs'
import { read as readCatalog } from './catalog.mjs'
import { mysqlDialect, sql } from './driver.mjs'

export async function inspect(connection, schema, table, allowMissing = false) {
  const [[target]] = await connection.execute('SELECT ENGINE,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?', [schema, table])
  if ((!target && !allowMissing) || (target && target.TABLE_TYPE !== 'BASE TABLE')) throw new MaintenanceError('维护仅支持已确认的 InnoDB 普通表。')
  if (target?.ENGINE && target.ENGINE !== 'InnoDB') throw new MaintenanceError('维护仅支持已确认的 InnoDB 普通表。')
  if (!target) return { columns: [], indexes: { status: 'actual', values: [] }, constraints: { status: 'actual', values: [] }, primaryKeys: [] }
  const metadata = await readCatalog(connection, { kind: 'table', schema, table })
  const indexes = await readCatalog(connection, { kind: 'indexes', schema, table })
  metadata.indexes = indexes.indexes
  metadata.constraints = { status: 'actual', values: [] }
  return metadata
}

export async function privileges(connection, schema, table) {
  const wanted = ['INSERT', 'UPDATE', 'DELETE']
  const allowAll = { insert: true, update: true, delete: true }
  const [rows] = await connection.query('SHOW GRANTS FOR CURRENT_USER')
  const allowed = new Set()
  let explicit = false
  const schemaName = schema.toLowerCase(), tableName = table.toLowerCase()
  for (const row of rows || []) {
    const text = String(Object.values(row)[0] || '')
    const match = text.match(/^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i)
    if (!match) continue
    const raw = match[1].trim().toUpperCase()
    if (raw === 'USAGE' || raw === 'PROXY') continue
    const scope = match[2].replaceAll('`', '').replaceAll('"', '').replaceAll("'", '').toLowerCase()
    if (scope !== '*.*' && scope !== `${schemaName}.*` && scope !== `${schemaName}.${tableName}`) continue
    const granted = (raw === 'ALL PRIVILEGES' || raw === 'ALL')
      ? wanted : raw.split(',').map(value => value.trim().replace(/\s*\(.*\)$/, ''))
    if (!granted.some(privilege => wanted.includes(privilege) || privilege === 'SELECT')) continue
    explicit = true
    for (const privilege of granted) if (wanted.includes(privilege)) allowed.add(privilege)
  }
  if (!explicit) return allowAll
  return { insert: allowed.has('INSERT'), update: allowed.has('UPDATE'), delete: allowed.has('DELETE') }
}

export async function dependencies(db, schema, table, creating = false) {
  if (creating) return []
  const [foreign] = await db.execute('SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME=? LIMIT 1', [schema, table])
  const [views] = await db.execute('SELECT VIEW_NAME FROM information_schema.VIEW_TABLE_USAGE WHERE TABLE_SCHEMA=? AND TABLE_NAME=? LIMIT 1', [schema, table])
  const [routines] = await db.query("SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA NOT IN ('mysql','sys','performance_schema','information_schema') LIMIT 1")
  if (foreign.length || views.length || routines.length) throw new MaintenanceError('存在外键、视图或无法完整核验的例程依赖，结构维护暂不开放。')
  return []
}

export async function sqlMode(db) {
  return String((await db.query('SELECT @@SESSION.sql_mode AS mode'))[0][0].mode)
}

export async function verifyIdentity() {}

export async function prepareDml(db, plan) {
  const target = `${sql.quote(plan.schema)}.${sql.quote(plan.table)}`
  await db.query('SET SESSION innodb_lock_wait_timeout=5')
  await db.beginTransaction()
  await db.query(`SELECT 1 FROM ${target} WHERE 1=0`)
}

export async function executeDml(db, plan) {
  const [result] = await db.execute(plan.sql, plan.params)
  return Number(result.affectedRows)
}

export const commit = db => db.commit()
export const rollback = db => db.rollback()

export async function prepareDdl(db, plan) {
  if (await sqlMode(db) !== plan.sqlMode) throw new MaintenanceError('会话 SQL 模式已变化，请重新预览。')
  await db.query('SET SESSION lock_wait_timeout=5')
  await db.query('SET SESSION innodb_lock_wait_timeout=5')
}

export const readDdl = (db, schema, table) => inspect(db, schema, table, true)
export const executeDdl = (db, text) => db.query(text)
export async function peekDdl(db, schema, table) {
  return (await db.query(`SELECT 1 FROM ${sql.quote(schema)}.${sql.quote(table)} LIMIT 1`))[0]
}

export const open = credentials => mysqlDialect.openMaintenance(credentials)
export const close = db => mysqlDialect.destroy(db)
export const isUncertainDdlError = error => /TIMEOUT|CONNECTION|PROTOCOL|ECONN|EPIPE/i.test(String(error?.code || ''))

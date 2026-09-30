import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Maintenance, assertExpectedAffectedRows } from '../src/host/maintenance.mjs'

function sqlText(sql) {
  return typeof sql === 'string' ? sql : String(sql?.sql || '')
}

function mysqlMaintenanceConnection({
  grants = ["GRANT SELECT, INSERT, UPDATE, DELETE ON `app`.* TO `sit`@`%`"],
  engine = 'InnoDB',
  grantError = false,
} = {}) {
  const run = async (sql) => {
    const text = sqlText(sql)
    if (text.includes('SHOW GRANTS')) {
      if (grantError) throw new Error('Access denied for SHOW GRANTS')
      return [grants.map(grant => ({ Grants: grant }))]
    }
    if (text.includes('information_schema.TABLES')) return [[{ ENGINE: engine, TABLE_TYPE: 'BASE TABLE' }]]
    if (text.includes('SHOW FULL COLUMNS')) return [[
      { Field: 'id', Type: 'bigint', Key: 'PRI', Extra: 'auto_increment', Null: 'NO' },
      { Field: 'name', Type: 'varchar(100)', Key: '', Extra: '', Null: 'YES' },
    ]]
    if (text.includes('SHOW INDEX')) return [[{
      Key_name: 'PRIMARY', Column_name: 'id', Non_unique: 0, Seq_in_index: 1, Index_type: 'BTREE',
    }]]
    return [[]]
  }
  return { query: run, execute: run }
}

test('affected row count must match before a transaction may commit', () => {
  assert.doesNotThrow(() => assertExpectedAffectedRows(1, 1))
  assert.throws(() => assertExpectedAffectedRows(0, 1), /实际影响 0 行/)
  assert.throws(() => assertExpectedAffectedRows(2, 1), /实际影响 2 行/)
  const source = readFileSync(new URL('../src/host/maintenance.mjs', import.meta.url), 'utf8')
  assert.ok(source.indexOf('assertExpectedAffectedRows(affected, plan.expectedRows)') < source.indexOf('await this.operations.commit(db)'))
})

test('schema-level CRUD grants can enable table maintenance without global TRIGGER', async () => {
  const maintenance = new Maintenance(mysqlMaintenanceConnection(), { environment: 'sit', dialect: 'mysql' })
  const capability = await maintenance.request({
    kind: 'capability', source: 'table', schema: 'app', table: 'user', conversationId: 'conversation-grants',
  })
  assert.equal(capability.canEnable, true)
  assert.equal(capability.canUpdate, true)
  assert.equal(capability.canInsert, true)
  assert.equal(capability.canDelete, true)
})

test('role-only grants still allow maintenance and let execute decide', async () => {
  const maintenance = new Maintenance(mysqlMaintenanceConnection({
    grants: [
      "GRANT USAGE ON *.* TO `sit`@`%`",
      "GRANT `writer`@`%` TO `sit`@`%`",
    ],
  }), { environment: 'sit', dialect: 'mysql' })
  const capability = await maintenance.request({
    kind: 'capability', source: 'table', schema: 'app', table: 'user', conversationId: 'conversation-role',
  })
  assert.equal(capability.canEnable, true)
  assert.equal(capability.canUpdate, true)
})

test('explicit SELECT-only grants stay read-only', async () => {
  const maintenance = new Maintenance(mysqlMaintenanceConnection({
    grants: ["GRANT SELECT ON `app`.* TO `sit`@`%`"],
  }), { environment: 'sit', dialect: 'mysql' })
  const capability = await maintenance.request({
    kind: 'capability', source: 'table', schema: 'app', table: 'user', conversationId: 'conversation-select',
  })
  assert.equal(capability.canEnable, false)
  assert.equal(capability.canUpdate, false)
})

test('SHOW GRANTS failure does not force the table read-only', async () => {
  const maintenance = new Maintenance(mysqlMaintenanceConnection({ grantError: true }), { environment: 'sit', dialect: 'mysql' })
  const capability = await maintenance.request({
    kind: 'capability', source: 'table', schema: 'app', table: 'user', conversationId: 'conversation-grant-error',
  })
  assert.equal(capability.canEnable, true)
  assert.equal(capability.canUpdate, true)
})

test('manually closing maintenance invalidates enabled state', async () => {
  const maintenance = new Maintenance(() => ({}), { environment: 'sit', dialect: 'mysql' })
  const conversationId = 'conversation-a'
  assert.equal((await maintenance.request({ kind: 'enable', enabled: true, conversationId })).enabled, true)
  assert.equal((await maintenance.request({ kind: 'enable', enabled: false, conversationId })).enabled, false)
  await assert.rejects(
    maintenance.request({ kind: 'execute', id: 'old', confirmed: true, conversationId }),
    /先人工开启/,
  )
})

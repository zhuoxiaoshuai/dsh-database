import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeQueryMaintenance, finalizeMaintenanceCapability } from '../src/host/maintenance-capability.mjs'

const metadata = {
  columns: [
    { name: 'id', type: 'bigint', key: 'PRI', extra: 'auto_increment' },
    { name: 'name', type: 'varchar(100)' },
    { name: 'status', type: 'int' },
  ],
  indexes: { status: 'actual', values: [] },
  constraints: { status: 'actual', values: [] },
}

test('simple single-table query maps direct and aliased columns', async () => {
  const shape = await analyzeQueryMaintenance('mysql', 'SELECT id, name AS display_name, status FROM app.user WHERE status=1', ['id', 'display_name', 'status'])
  assert.equal(shape.table, 'user')
  assert.equal(shape.schema, 'app')
  assert.deepEqual(shape.columns.map(column => column.sourceColumn), ['id', 'name', 'status'])
  const capability = finalizeMaintenanceCapability({ source: 'query', schema: 'app', table: 'user', dialect: 'mysql', metadata, shape })
  assert.equal(capability.canInsert, true)
  assert.equal(capability.canUpdate, true)
  assert.equal(capability.canDelete, true)
  assert.equal(capability.columns[0].editable, false)
})

test('computed columns are read-only and disable query-result insertion', async () => {
  const shape = await analyzeQueryMaintenance('mysql', 'SELECT id, UPPER(name) AS name FROM user', ['id', 'name'])
  const capability = finalizeMaintenanceCapability({ source: 'query', schema: 'app', table: 'user', dialect: 'mysql', metadata, shape })
  assert.equal(capability.canInsert, false)
  assert.equal(capability.canDelete, false)
  assert.equal(capability.canUpdate, false)
  assert.equal(capability.canEnable, false)
  assert.match(capability.columns[1].reason, /表达式/)
})

test('unsafe query shapes are rejected with concrete reasons', async () => {
  const cases = [
    ['SELECT u.id FROM user u JOIN role r ON r.id=u.role_id', /JOIN/],
    ['SELECT DISTINCT id FROM user', /DISTINCT/],
    ['SELECT status, COUNT(*) n FROM user GROUP BY status', /聚合/],
    ['SELECT id FROM user UNION SELECT id FROM old_user', /集合/],
    ['WITH x AS (SELECT * FROM user) SELECT * FROM x', /CTE/],
    ['SELECT * FROM (SELECT * FROM user) x', /派生表/],
  ]
  for (const [sql, reason] of cases) {
    const capability = await analyzeQueryMaintenance('mysql', sql, ['id'])
    assert.equal(capability.canEnable, false)
    assert.match(capability.reason, reason)
  }
})

test('keyless table is entirely non-maintainable', () => {
  const capability = finalizeMaintenanceCapability({
    source: 'table', schema: 'app', table: 'logs', dialect: 'mysql',
    metadata: { ...metadata, columns: metadata.columns.map(column => ({ ...column, key: '' })) },
  })
  assert.equal(capability.canEnable, false)
  assert.equal(capability.canInsert, false)
  assert.equal(capability.canUpdate, false)
  assert.equal(capability.canDelete, false)
})

test('operation privileges downgrade independently', () => {
  const capability = finalizeMaintenanceCapability({
    source: 'table', schema: 'app', table: 'user', dialect: 'mysql', metadata,
    privileges: { insert: false, update: true, delete: false },
  })
  assert.equal(capability.canInsert, false)
  assert.equal(capability.canUpdate, true)
  assert.equal(capability.canDelete, false)
})

test('Oracle direct projections use the same conservative mapping', async () => {
  const shape = await analyzeQueryMaintenance('oracle', 'SELECT ID, NAME AS DISPLAY_NAME FROM USERS WHERE STATUS=1', ['ID', 'DISPLAY_NAME'])
  assert.equal(shape.table, 'USERS')
  assert.deepEqual(shape.columns.map(column => column.sourceColumn), ['ID', 'NAME'])
})

test('query missing the complete primary key is entirely non-maintainable', async () => {
  const shape = await analyzeQueryMaintenance('mysql', 'SELECT name, status FROM user', ['name', 'status'])
  const capability = finalizeMaintenanceCapability({ source: 'query', schema: 'app', table: 'user', dialect: 'mysql', metadata, shape })
  assert.equal(capability.canEnable, false)
  assert.equal(capability.canInsert, false)
  assert.equal(capability.canUpdate, false)
  assert.equal(capability.canDelete, false)
  assert.match(capability.updateReason, /主键/)
})

test('WHERE subquery filters still map a single outer base table', async () => {
  const cases = [
    ['SELECT id, name, status FROM user WHERE id IN (SELECT user_id FROM logs WHERE ok=1)', 'user'],
    ['SELECT id, name, status FROM app.user WHERE EXISTS (SELECT 1 FROM logs WHERE logs.user_id = user.id)', 'user'],
    ['SELECT id, name, status FROM user WHERE status = (SELECT MAX(status) FROM user)', 'user'],
  ]
  for (const [sql, table] of cases) {
    const shape = await analyzeQueryMaintenance('mysql', sql, ['id', 'name', 'status'])
    assert.equal(shape.table, table, sql)
    assert.equal(shape.hasExpression, false, sql)
    const capability = finalizeMaintenanceCapability({ source: 'query', schema: 'app', table, dialect: 'mysql', metadata, shape })
    assert.equal(capability.canEnable, true, sql)
    assert.equal(capability.canUpdate, true, sql)
  }
  const oracle = await analyzeQueryMaintenance(
    'oracle',
    'SELECT ID, NAME FROM USERS WHERE ID IN (SELECT USER_ID FROM LOGS WHERE OK=1)',
    ['ID', 'NAME'],
  )
  assert.equal(oracle.table, 'USERS')
  assert.deepEqual(oracle.columns.map(column => column.sourceColumn), ['ID', 'NAME'])
})

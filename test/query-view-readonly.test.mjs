import test from 'node:test'
import assert from 'node:assert/strict'
import { authorizeSelect, authorizeStatement } from '../src/host/query-policy.mjs'
import { assertWritableTargets, blockedWriteObjectMessage, MYSQL_TABLE_TYPE_SQL, ORACLE_OBJECT_TYPE_SQL } from '../src/host/query.mjs'

test('catalog SELECT against a view remains authorized', async () => {
  const mysql = await authorizeSelect('mysql', 'SELECT * FROM v_orders LIMIT 100', 'business')
  assert.equal(mysql.kind, 'select')
  assert.ok(mysql.tables.includes('v_orders'))
  const oracle = await authorizeSelect('oracle', 'SELECT * FROM V_ORDERS FETCH FIRST 100 ROWS ONLY', 'HR')
  assert.equal(oracle.kind, 'select')
  assert.ok(oracle.tables.includes('V_ORDERS'))
})

test('SQL-page UPDATE targets include schema for Host object-type checks', async () => {
  const mysql = await authorizeStatement('mysql', 'UPDATE v_orders SET note = \'x\'', 'business')
  assert.deepEqual(mysql.targets, [{ schema: 'business', name: 'v_orders' }])
  const oracle = await authorizeStatement('oracle', 'UPDATE V_ORDERS SET NOTE = \'x\'', 'HR')
  assert.deepEqual(oracle.targets, [{ schema: 'HR', name: 'V_ORDERS' }])
  const qualified = await authorizeStatement('oracle', 'UPDATE OTHER.V_ORDERS SET NOTE = \'x\'', 'HR')
  assert.deepEqual(qualified.targets, [{ schema: 'OTHER', name: 'V_ORDERS' }])
})

test('Host rejects VIEW, materialized view and synonym writes; allows base tables', async () => {
  blockedWriteObjectMessage('TABLE')
  blockedWriteObjectMessage('BASE TABLE')
  assert.throws(() => blockedWriteObjectMessage('VIEW'), /视图只读/)
  assert.throws(() => blockedWriteObjectMessage('MATERIALIZED VIEW'), /视图只读/)
  assert.throws(() => blockedWriteObjectMessage('SYNONYM'), /同义词/)
  assert.throws(() => blockedWriteObjectMessage(''), /无法确认/)
  await assert.rejects(assertWritableTargets('oracle', [{ schema: 'HR', name: 'V_ORDERS' }], async () => [['VIEW']]), /视图只读/)
  await assert.rejects(assertWritableTargets('mysql', [{ schema: 'biz', name: 'v_orders' }], async () => [{ TABLE_TYPE: 'VIEW' }]), /视图只读/)
  await assertWritableTargets('oracle', [{ schema: 'HR', name: 'ORDERS' }], async () => [['TABLE']])
  await assertWritableTargets('mysql', [{ schema: 'biz', name: 'orders' }], async () => [{ type: 'BASE TABLE' }])
  assert.match(MYSQL_TABLE_TYPE_SQL, /information_schema\.TABLES/)
  assert.match(ORACLE_OBJECT_TYPE_SQL, /all_objects/)
  assert.ok(!ORACLE_OBJECT_TYPE_SQL.includes("' +"))
})

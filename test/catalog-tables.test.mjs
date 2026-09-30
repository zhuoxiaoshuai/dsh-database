import test from 'node:test'
import assert from 'node:assert/strict'
import { catalog, normalizeConstraints, normalizeIndexes } from '../src/host/catalog.mjs'

test('mysql table pages reuse one SHOW FULL TABLES result', async () => {
  let shows = 0
  const rows = Array.from({ length: 250 }, (_, index) => ({ name: `t${index}`, Table_type: 'BASE TABLE' }))
  const connection = {
    query: async ({ sql }) => {
      if (/SHOW FULL TABLES/i.test(sql)) {
        shows += 1
        return [rows]
      }
      return [[]]
    },
  }
  const first = await catalog(connection, 'mysql', { kind: 'tables', schema: 'biz', offset: 0 })
  const second = await catalog(connection, 'mysql', { kind: 'tables', schema: 'biz', offset: 100 })
  const third = await catalog(connection, 'mysql', { kind: 'tables', schema: 'biz', offset: 200 })
  assert.equal(shows, 1)
  assert.equal(first.items.length, 100)
  assert.equal(first.more, true)
  assert.equal(second.items[0].name, 't100')
  assert.equal(third.items.length, 50)
  assert.equal(third.more, false)
  await catalog(connection, 'mysql', { kind: 'tables', schema: 'biz', offset: 0, refresh: true })
  assert.equal(shows, 2)
})

test('catalog aborts before issuing SQL when the signal is already cancelled', async () => {
  let queried = 0
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(catalog({ query: async () => { queried += 1; return [[]] } }, 'mysql', { kind: 'schemas' }, controller.signal), /取消/)
  assert.equal(queried, 0)
})

test('catalog normalizes driver-specific index and constraint rows', () => {
  assert.deepEqual(normalizeIndexes([
    { Key_name: 'PRIMARY', Non_unique: 0, Column_name: 'tenant_id', Seq_in_index: 1, Index_type: 'BTREE' },
    { Key_name: 'PRIMARY', Non_unique: 0, Column_name: 'id', Seq_in_index: 2, Index_type: 'BTREE' },
  ]), [{ name: 'PRIMARY', unique: true, type: 'PRIMARY', columns: ['tenant_id', 'id'] }])
  assert.deepEqual(normalizeConstraints([
    { constraint_name: 'PK_ORDERS', constraint_type: 'P', column_name: 'TENANT_ID', position: 1, status: 'ENABLED' },
    { constraint_name: 'PK_ORDERS', constraint_type: 'P', column_name: 'ID', position: 2, status: 'ENABLED' },
  ]), [{
    name: 'PK_ORDERS', type: 'primary', columns: ['TENANT_ID', 'ID'], status: 'ENABLED',
    referencedOwner: undefined, referencedConstraint: undefined, deleteRule: undefined, expression: undefined,
  }])
})

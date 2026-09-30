import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBrowse } from '../src/host/browse.mjs'
import { authorizeSelect } from '../src/host/query-policy.mjs'
const metadata = { columns: [{ name: 'id', key: 'PRI' }, { name: 'note' }] }
test('browse binds filters and preserves stable primary ordering at the database', async () => {
  const plan = buildBrowse('mysql', { schema: 'business', table: 'records', page: 1, filters: [{ column: 'note', operator: 'contains', value: "%' OR 1=1 --" }], sort: { column: 'note', direction: 'DESC' } }, metadata)
  assert.ok(!plan.sql.includes('OR 1=1')); assert.ok(plan.sql.includes('`note` DESC, `id` ASC')); assert.ok(plan.sql.includes('OFFSET 100')); assert.deepEqual(plan.params, ["%!%' OR 1=1 --%"])
  assert.ok((await authorizeSelect('mysql', plan.sql, 'business')).tables.includes('records'))
})
test('browse refuses forged fields, ordering, operators, oversized filters and invalid pages', () => {
  for (const extra of [{ page: -1 }, { filters: [{ column: 'id; DROP', operator: 'eq', value: '1' }] }, { sort: { column: 'id', direction: 'DESC;DELETE' } }, { filters: [{ column: 'id', operator: '__proto__', value: '1' }] }]) assert.throws(() => buildBrowse('mysql', { schema: 'business', table: 'records', page: 0, ...extra }, metadata))
})
test('CTE names do not hide qualified physical tables from object checks', async () => {
  assert.ok((await authorizeSelect('mysql', 'WITH records AS (SELECT 1 AS id) SELECT * FROM business.records', 'business')).tables.includes('records'))
  assert.ok((await authorizeSelect('oracle', 'WITH records AS (SELECT 1 AS id FROM DUAL) SELECT * FROM BUSINESS.RECORDS', 'BUSINESS')).tables.includes('RECORDS'))
})

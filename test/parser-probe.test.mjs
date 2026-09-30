import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectSyntax } from '../experiments/parse.mjs'
for (const dialect of ['mysql', 'oracle']) {
  for (const sql of [
    'SELECT id, name FROM customers WHERE id = 1',
    "SELECT c.id, COUNT(o.id) AS total FROM customers c LEFT JOIN orders o ON c.id = o.customer_id GROUP BY c.id HAVING COUNT(o.id) > 1 ORDER BY c.id",
    "SELECT id FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE name = 'test')",
    "INSERT INTO orders (id, status) VALUES (1, 'paid')",
    "UPDATE orders SET status = 'paid' WHERE id = 1",
    'DELETE FROM orders WHERE id = 1',
    "SELECT 'DELETE; DROP TABLE x' AS note FROM orders",
    'SELECT id /* comment */ FROM orders',
  ]) test(`${dialect} candidate recognizes: ${sql.slice(0, 55)}`, () => {
    const parsed = inspectSyntax(dialect, sql)
    assert.equal(parsed.parsed, true, JSON.stringify(parsed)); assert.equal(parsed.statements, 1)
  })
  test(`${dialect} candidate rejects malformed input`, () => assert.equal(inspectSyntax(dialect, 'SELECT FROM WHERE').parsed, false))
  test(`${dialect} exposes multiple statements for later policy refusal`, () => assert.equal(inspectSyntax(dialect, 'SELECT id FROM orders; DELETE FROM orders;').statements, 2))
}
test('Oracle pagination and bind syntax are recognized in the Oracle parser', () => {
  assert.equal(inspectSyntax('oracle', 'SELECT "ID" FROM "ORDERS" WHERE "STATUS" = :status FETCH FIRST 100 ROWS ONLY').parsed, true)
})
test('MySQL pagination and bind syntax are recognized in the MySQL parser', () => {
  assert.equal(inspectSyntax('mysql', 'SELECT `id` FROM `orders` WHERE `status` = ? LIMIT 100').parsed, true)
})
test('Oracle PL/SQL block is distinguishable from ordinary SQL, not auto-authorized', () => {
  const result = inspectSyntax('oracle', 'BEGIN NULL; END;')
  assert.ok(result.parsed); assert.ok(result.types.some(t => /anonymous|block/i.test(t)))
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { exportResult, quoteIdentifier, selectTable, visibleTables, unavailableBridge } from '../src/workbench.ts'
import { previewBridge } from '../preview/fixture.ts'
const result = { columns: ['id', 'note'], rows: [['9007199254740993', '客户, "备注"'], [null, '=1+1']], elapsedMs: 1, truncated: true }
test('CSV escapes separators/quotes and neutralizes formulas without losing large integer digits', () => {
  const csv = exportResult(result, 'csv')
  assert.ok(csv.includes('9007199254740993')); assert.ok(csv.includes('"客户, ""备注"""')); assert.ok(csv.includes("'=1+1"))
})
test('JSON preserves null, string values and truncation metadata', () => assert.deepEqual(JSON.parse(exportResult(result, 'json')), { truncated: true, columns: result.columns, rows: result.rows }))
test('Markdown escapes pipes and newlines and identifies truncated results', () => {
  const text = exportResult({ ...result, rows: [['1', 'a|b\nc']] }, 'markdown')
  assert.ok(text.includes('a\\|b<br>c')); assert.ok(text.includes('结果已截断'))
})
test('identifier escaping keeps each target a single identifier for both dialects', () => {
  assert.equal(quoteIdentifier('mysql', 'a`b'), '`a``b`'); assert.equal(quoteIdentifier('oracle', 'a"b'), '"a""b"')
})
test('object search matches fields and Chinese descriptions', () => {
  const tables = previewBridge.tables(previewBridge.connections[0])
  assert.equal(visibleTables(tables, 'order_no')[0].name, 'orders')
  assert.equal(visibleTables(tables, '订单主')[0].name, 'orders')
  assert.equal(visibleTables(tables, 'not_present').length, 0)
})
test('both demo dialects load explicit fixtures, arbitrary SQL is never falsely reported as executed', async () => {
  for (const c of previewBridge.connections) {
    const table = previewBridge.tables(c)[0], sql = selectTable(c, table)
    const out = await previewBridge.execute(c, sql, new AbortController().signal)
    assert.equal(out.rows.length, 12); assert.ok(out.message.includes('未连接数据库'))
    await assert.rejects(previewBridge.execute(c, 'DELETE FROM orders;', new AbortController().signal), /原型/)
  }
})
test('real host bridge has no fixture connections or executor', async () => {
  assert.equal(unavailableBridge.mode, 'host'); assert.deepEqual(unavailableBridge.connections, [])
  await assert.rejects(unavailableBridge.execute(), /未执行任何 SQL/)
})

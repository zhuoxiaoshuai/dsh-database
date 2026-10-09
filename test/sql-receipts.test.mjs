import test from 'node:test'
import assert from 'node:assert/strict'
import { sqlReceiptSteps } from '../src/shared/sql-receipts.ts'
import { createSqlBatch, runSqlBatch } from '../src/shared/sql-batch.ts'
import { clipResultPreview } from '../src/shared/execution.ts'
import { preferLiveGrid } from '../src/shared/query-sync.ts'
import { sqlModel } from '../src/host/sql-operation.ts'
const empty = { columns: [], rows: [], truncated: false, elapsedMs: 0 }

test('manual, shared and recovered receipts preserve committed rows beyond the preview budget', async () => {
  const steps = [...Array.from({ length: 9 }, (_, index) => ({ index, sql: 'UPDATE demo SET x=' + index, status: 'succeeded', affectedRows: index + 1 })),
    { index: 9, sql: 'UPDATE demo SET x=9', status: 'unknown' }, { index: 10, sql: 'UPDATE demo SET x=10', status: 'not-run' }]
  const result = { ...empty, steps, batch: steps.slice(0, 9).map(item => ({ ...empty, stepIndex: item.index, affectedRows: item.affectedRows })) }
  const preview = clipResultPreview(result)
  const manual = await runSqlBatch({ steps: createSqlBatch(steps.map(item => item.sql)), signal: new AbortController().signal,
    execute: async () => { throw Object.assign(new Error('lost receipt'), preview) } })
  const common = sqlReceiptSteps(preview)
  for (let i = 0; i < steps.length; i++) {
    assert.equal(manual[i].status, common[i].status)
    assert.equal(manual[i].result?.affectedRows, common[i].result?.affectedRows)
  }
  assert.equal(manual[8].result.affectedRows, 9)
  assert.equal(manual[9].result, undefined); assert.equal(manual[10].status, 'skipped')
})

test('indexed previews cannot attach to another committed step after clipping', () => {
  const steps = [{ index: 0, sql: 'UPDATE a', status: 'succeeded', affectedRows: 1 }, { index: 1, sql: 'SELECT b', status: 'succeeded' }]
  const output = sqlReceiptSteps({ steps, batch: [{ ...empty, stepIndex: 1, columns: ['b'], rows: [['only-b']] }] })
  assert.equal(output[0].result.affectedRows, 1); assert.deepEqual(output[0].result.columns, [])
  assert.equal(output[1].result.rows[0][0], 'only-b')
})

test('model output uses the same receipts when successful previews were clipped', () => {
  const steps = [...Array.from({ length: 9 }, (_, index) => ({ index, sql: 'UPDATE demo SET x=' + index, status: 'succeeded', affectedRows: index + 1 })),
    { index: 9, sql: 'UPDATE uncertain', status: 'unknown', message: 'receipt lost' }, { index: 10, sql: 'UPDATE later', status: 'not-run' }]
  const model = sqlModel({ ...empty, steps, batch: steps.slice(0, 8).map(step => ({ ...empty, stepIndex: step.index, affectedRows: step.affectedRows })) }, 'batch', false)
  assert.equal(model.statements.length, 11)
  assert.equal(model.statements[8].affectedRows, 9)
  assert.equal(model.statements[9].status, 'unknown'); assert.equal(model.statements[9].affectedRows, undefined)
  assert.equal(model.statements[10].status, 'not-run')
})
test('receipts preserve committed facts and do not associate a failed step with the last result', () => {
  const result = { ...empty, batch: [{ ...empty, affectedRows: 1, sql: 'INSERT 1' }], steps: [
    { index: 0, sql: 'INSERT 1', status: 'succeeded', affectedRows: 1 },
    { index: 1, sql: 'INSERT 2', status: 'unknown', message: 'receipt lost' },
    { index: 2, sql: 'INSERT 3', status: 'not-run' },
  ] }
  const steps = sqlReceiptSteps(result)
  assert.deepEqual(steps.map(x => x.status), ['ok', 'unknown', 'skipped'])
  assert.equal(steps[0].result.affectedRows, 1); assert.equal(steps[1].result, undefined); assert.equal(steps[2].result, undefined)
  assert.deepEqual(sqlReceiptSteps(clipResultPreview(result)).map(x => x.status), ['ok', 'unknown', 'skipped'])
  assert.deepEqual(sqlReceiptSteps(empty), [])
})
test('missing bounded previews do not erase the matching step or invent a result', () => {
  const result = { ...empty, batch: [], steps: [{ index: 4, sql: 'SELECT 5', status: 'succeeded' }] }
  assert.equal(sqlReceiptSteps(result)[0].index, 4)
  assert.equal(sqlReceiptSteps(result)[0].result, undefined)
})


test('late empty failure event cannot replace the committed batch prefix', () => {
  const result = { ...empty, steps: [{ index: 0, sql: 'INSERT 1', status: 'succeeded' }] }
  const current = { executionId: 'same', result }
  assert.equal(preferLiveGrid(current, { executionId: 'same', result: empty }).result, result)
})

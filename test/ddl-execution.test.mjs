import test from 'node:test'
import assert from 'node:assert/strict'
import { runDdlSteps } from '../src/host/maintenance.mjs'
import { createHash } from 'node:crypto'
const metadata = { columns: [{ name: 'id' }], indexes: {}, constraints: {} }
const revision = createHash('sha256').update(JSON.stringify(metadata)).digest('hex')
const steps = Array.from({ length: 3 }, (_, i) => ({ kind: 'comment', table: 'example', afterTable: 'example', sql: `step ${i}`, state: 'not-run' }))
const base = { steps, revision, read: async () => metadata, dependencies: async () => {}, peek: async () => [] }

test('DDL preserves committed steps and stops after database rejection without retry', async () => {
  const calls = [], receipts = []
  const result = await runDdlSteps({ ...base, progress: value => receipts.push(structuredClone(value)), execute: async sql => { calls.push(sql); if (sql === 'step 1') throw Object.assign(new Error('constraint violation'), { code: 'ORA-02293' }) } })
  assert.deepEqual(calls, ['step 0', 'step 1'])
  assert.deepEqual(result.steps.map(s => s.state), ['success', 'failed', 'not-run'])
  assert.equal(result.status, 'partial')
  assert.equal(receipts[0].steps[0].state, 'unknown', 'Emit uncertainty before sending SQL')
  assert.equal(steps[0].state, 'not-run', 'Execution cannot mutate approval plan')
})

test('DDL committed command with failed reconciliation stays unknown even if later dictionary read succeeds', async () => {
  let reads = 0, executions = 0
  const result = await runDdlSteps({ ...base, execute: async () => { executions++ }, read: async () => { if (++reads === 1) throw Object.assign(new Error('dictionary failure'), { code: 'ER_TABLEACCESS_DENIED_ERROR' }); return metadata } })
  assert.equal(executions, 1)
  assert.deepEqual(result.steps.map(s => s.state), ['unknown', 'not-run', 'not-run'])
  assert.equal(result.status, 'unknown')
})

test('DDL disconnect and nonempty truncate reconciliation stop with unknown status', async () => {
  const disconnected = await runDdlSteps({ ...base, execute: async () => { throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }) } })
  assert.equal(disconnected.steps[0].state, 'unknown')
  const truncated = await runDdlSteps({ ...base, steps: [{ ...steps[0], kind: 'truncateTable' }, steps[1]], execute: async () => {}, peek: async () => [[1]] })
  assert.deepEqual(truncated.steps.map(s => s.state), ['unknown', 'not-run'])
})

test('DDL refuses subsequent statement when external structure changes between steps', async () => {
  let reads = 0, executions = 0
  const result = await runDdlSteps({ ...base, execute: async () => { executions++ }, read: async () => ++reads > 1 ? { ...metadata, columns: [...metadata.columns, { name: 'external' }] } : metadata })
  assert.equal(executions, 1)
  assert.deepEqual(result.steps.map(s => s.state), ['success', 'failed', 'not-run'])
})

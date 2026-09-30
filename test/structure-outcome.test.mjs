import test from 'node:test'
import assert from 'node:assert/strict'
import { structureExecuteOutcome, structureStatusLabel } from '../src/shared/structure-outcome.ts'

test('structure overall status keeps backend partial, failed and unknown', () => {
  assert.equal(structureExecuteOutcome({ status: 'success', message: 'ok' }).status, 'success')
  assert.equal(structureExecuteOutcome({ status: 'partial', message: 'step 2 failed', steps: [{ sql: 'a', kind: 'addColumn', state: 'failed' }] }).status, 'partial')
  assert.equal(structureExecuteOutcome({ status: 'failed', message: 'denied' }).status, 'failed')
  assert.equal(structureExecuteOutcome({ status: 'unknown', message: 'timeout', steps: [{ sql: 'a', kind: 'addColumn', state: 'unknown' }] }).status, 'unknown')
  assert.equal(structureStatusLabel('partial'), '部分失败')
  assert.equal(structureStatusLabel('failed'), '失败')
  assert.equal(structureStatusLabel('unknown'), '结果未知')
})

test('structure maps request interruption without a backend status to unknown', () => {
  const outcome = structureExecuteOutcome(undefined, [{ sql: 'ALTER', kind: 'addColumn', state: 'not-run' }])
  assert.equal(outcome.status, 'unknown')
  assert.match(outcome.message || '', /结果未知/)
  assert.equal(outcome.steps?.[0].state, 'not-run')
})

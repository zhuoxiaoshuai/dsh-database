import test from 'node:test'
import assert from 'node:assert/strict'
import { executeDmlOp } from '../src/client/execute-dml.ts'

test('grid save previews then executes without surfacing SQL to the caller', async () => {
  const calls = []
  const bridge = {
    maintenance: async (_connection, input) => {
      calls.push(input.kind)
      if (input.kind === 'preview') return { id: 'r1', sql: 'UPDATE t SET a=?' }
      if (input.kind === 'execute') return { status: 'success' }
      return {}
    },
  }
  await executeDmlOp(bridge, { id: 'c1' }, 'app', 'orders', { kind: 'update', values: { a: '1' }, original: { id: '9', a: '0' } })
  assert.deepEqual(calls, ['preview', 'execute'])
})

test('failed execute rejects the preview ticket', async () => {
  const calls = []
  const bridge = {
    maintenance: async (_connection, input) => {
      calls.push(input.kind)
      if (input.kind === 'preview') return { id: 'r1' }
      if (input.kind === 'execute') throw new Error('记录已被其他会话修改或删除，本次已回滚；请保留草稿并刷新。')
      return {}
    },
  }
  await assert.rejects(
    () => executeDmlOp(bridge, { id: 'c1' }, 'app', 'orders', { kind: 'update', values: { a: '1' }, original: { id: '9' } }),
    /其他会话/,
  )
  assert.deepEqual(calls, ['preview', 'execute', 'reject'])
})

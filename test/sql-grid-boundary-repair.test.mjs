import test from 'node:test'
import assert from 'node:assert/strict'
import { executeDmlOp, saveDmlOperations } from '../src/client/execute-dml.ts'
import { canReplaySqlRun } from '../src/client/sql/run-snapshot.ts'

const connection = { id: 'repair', name: 'repair', generation: 'g1' }
const operation = { kind: 'update', values: { value: 'new' }, original: { id: '1' } }

test('original SQL replay snapshot invalidates on target changes, reconnect, switch back and unmount', () => {
  const snapshot = { identity: 'connection-g1-app', schema: 'app', seq: 1, connectionId: 'connection', generation: 'g1', statements: ['UPDATE items SET value=1'] }
  const check = (identity, epoch, mounted = true, statements = snapshot.statements) => canReplaySqlRun(snapshot, identity, epoch, mounted, statements)
  assert.equal(check(snapshot.identity, 1), true)
  assert.equal(check('connection-g1-other', 2), false)
  assert.equal(check(snapshot.identity, 3), false)
  assert.equal(check('connection-g2-app', 2), false)
  assert.equal(check(snapshot.identity, 1, false), false)
  assert.equal(check(snapshot.identity, 1, true, ['UPDATE items SET value=2']), false)
})

test('target invalidated while preview waits releases ticket and never dispatches execute', async () => {
  let current = true, release
  const calls = []
  const bridge = { maintenance: async (_, input) => {
    calls.push(input.kind)
    if (input.kind === 'preview') return await new Promise(resolve => { release = resolve })
    return {}
  } }
  const save = executeDmlOp(bridge, connection, 'original', 'items', operation, () => current)
  current = false
  release({ id: 'preview-1' })
  await assert.rejects(save, error => error.effect === 'none' && error.phase === 'check')
  assert.deepEqual(calls, ['preview', 'reject'])
})

test('invalid snapshot before preview sends zero maintenance requests', async () => {
  let sent = 0
  await assert.rejects(executeDmlOp({ maintenance: async () => { sent++; return {} } }, connection, 'original', 'items', operation, () => false))
  assert.equal(sent, 0)
})

test('already dispatched write keeps trustworthy receipt after invalidation; later item not sent', async () => {
  let current = true, release
  const calls = [], committed = []
  const bridge = { maintenance: async (_, input) => {
    calls.push(input.kind)
    if (input.kind === 'preview') return { id: 'p1' }
    if (input.kind === 'execute') return await new Promise(resolve => { release = resolve })
    return {}
  } }
  const operations = [{ ...operation }, { ...operation }]
  const save = saveDmlOperations(operations, op => executeDmlOp(bridge, connection, 'original', 'items', op, () => current), op => committed.push(op))
  await new Promise(resolve => setImmediate(resolve))
  current = false; release({ status: 'success' })
  await assert.rejects(save, error => error.effect === 'none')
  assert.equal(committed.length, 1)
  assert.equal(operations.length, 1)
  assert.deepEqual(calls, ['preview', 'execute'])
})

test('explicit empty string and NULL remain distinct and omitted fields stay omitted in preview', async () => {
  let values
  await executeDmlOp({ maintenance: async (_, input) => {
    if (input.kind === 'preview') { values = input.operation.values; return { id: 'p' } }
    return { status: 'success' }
  } }, connection, 'original', 'items', { kind: 'insert', values: { empty: '', nullable: null } })
  assert.deepEqual(values, { empty: '', nullable: null })
  assert.equal(Object.hasOwn(values, 'defaulted'), false)
})

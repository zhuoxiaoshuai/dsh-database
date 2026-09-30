import test from 'node:test'
import assert from 'node:assert/strict'
import { runOperation } from '../src/host/operation-runtime.ts'

test('a bounded partial result ends one execution with its provider status and call correlation', async () => {
  const created = [], completed = []
  const executions = {
    create(input) { created.push(input); return { executionId: 'once' } },
    attachAbort() {}, event() {}, transition() {},
    complete(...args) { completed.push(args) },
  }
  const binding = { owner: 'owner', connectionId: 'connection', generation: 'g1', connectionName: 'Kafka', sourceId: 'kafka', environment: 'sit' }
  const result = await runOperation(executions, binding, { operation: 'kafka_peek', title: '读取', initiator: 'ai', callId: 'call', rootCallId: 'root' },
    async () => ({ kind: 'peek', reason: 'deadline', messages: [{ offset: '1' }] }),
    value => `已读取 ${value.messages.length} 条，未完成。`, undefined, value => value.reason === 'deadline' ? 'failed' : 'succeeded')
  assert.equal(created.length, 1)
  assert.equal(created[0].rootCallId, 'root')
  assert.equal(result.executionId, 'once')
  assert.equal(result.executionStatus, 'failed')
  assert.deepEqual(completed, [['once', 'failed', '已读取 1 条，未完成。']])
})

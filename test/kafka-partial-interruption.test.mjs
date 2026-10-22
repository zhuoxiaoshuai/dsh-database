import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { ConnectionService } from '../src/host/connection-service.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { hostDeadlineFor } from '../src/host/request-timeouts.mjs'
import { temporaryDirectory } from './helpers.mjs'

for (const interruption of ['abort', 'execution-cancel', 'exit', 'error', 'terminal-error', 'invalid-reply', 'timeout']) test(`Kafka batch preserves confirmed prefix on ${interruption}, without replay or terminal upgrade`, async t => {
  const directory = temporaryDirectory(t, 'kafka-partial-')
  const executions = new ExecutionStore(directory)
  let worker, ready, dispatches = 0, requestId
  const progressReady = new Promise(resolve => { ready = resolve })
  const receipt = { index: 0, partition: 0, baseOffset: '42', acknowledged: true }
  class ControlledWorker extends EventEmitter {
    postMessage(message) {
      if (message.cancel) return
      if (!message.requestId) { queueMicrotask(() => this.emit('message', { ready: true, ok: true, result: { version: 'fixture', health: 'ready', database: '' } })); return }
      dispatches++; requestId = message.requestId
      queueMicrotask(() => { this.emit('message', { requestId, progress: { kind: 'produce-batch', topic: 'demo', receipts: [receipt], failedIndex: 1, notSent: 0, status: 'unknown' } }); ready() })
    }
    async terminate() { this.emit('exit', 0); return 0 }
  }
  const service = new ConnectionService(() => true, directory, undefined, undefined, executions, undefined, () => (worker = new ControlledWorker()))
  t.after(async () => { await service.dispose(); executions.dispose() })
  const connection = await service.open('owner', { dialect: 'kafka', name: 'fixture', brokers: ['127.0.0.1:9092'], tls: false, saslMechanism: 'none', environment: 'sit' }, false)
  if (interruption === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] })
  const abort = new AbortController()
  const text = 'PRODUCE_BATCH {"topic":"demo","messages":[{"value":"a"},{"value":"b"}]}'
  const document = service.getExecutionDocument('owner', connection.id, connection.generation)
  const updated = service.updateExecutionDocument('owner', connection.id, text, 'user', document.revision, connection.generation)
  const events = [], emit = executions.emitWorkbench.bind(executions)
  executions.emitWorkbench = (owner, event) => { events.push(event); emit(owner, event) }
  const pending = service.executeText('owner', connection.id, connection.generation, text, abort.signal, 'user', undefined, updated.revision).catch(error => error)
  await progressReady
  if (interruption === 'abort') abort.abort()
  if (interruption === 'execution-cancel') executions.cancel('owner', executions.list('owner')[0].executionId, true)
  if (interruption === 'exit') worker.emit('exit', 1)
  if (interruption === 'error') worker.emit('error', new Error('fixture transport closed'))
  if (interruption === 'terminal-error') worker.emit('message', { requestId, error: 'fixture batch failed', effect: 'none' })
  if (interruption === 'invalid-reply') worker.emit('message', { requestId, error: 42 })
  if (interruption === 'timeout') t.mock.timers.tick(hostDeadlineFor('kafka-produce-batch') + 1)
  const error = await pending
  assert.equal(error.executionStatus, 'unknown')
  assert.equal(error.sourceResult.executionStatus, 'unknown')
  assert.deepEqual(error.sourceResult.receipts, [receipt])
  const stored = executions.get('owner', error.executionId, true)
  assert.equal(stored.status, 'unknown')
  assert.equal(stored.resultEnvelope.status, 'unknown')
  assert.deepEqual(stored.resultEnvelope.payload.receipts, [receipt])
  assert.equal(executions.latestDisplay('owner', connection.id).executionId, error.executionId)
  if (!['exit', 'error', 'timeout'].includes(interruption)) {
    const finished = events.filter(event => event.type === 'EXECUTION_FINISHED')
    assert.equal(finished.length, 1)
    assert.equal(finished[0].status, 'unknown')
    assert.deepEqual(finished[0].sourceResult.receipts, [receipt])
  }
  assert.equal(events.filter(event => event.type === 'EXECUTION_FINISHED' && event.status === 'succeeded').length, 0)
  worker.emit('message', { requestId, result: { kind: 'produce-batch', topic: 'demo', status: 'succeeded', receipts: [receipt, { index: 1, partition: 0, baseOffset: '43', acknowledged: true }], notSent: 0 } })
  const after = executions.get('owner', error.executionId, true)
  assert.equal(after.status, 'unknown')
  assert.deepEqual(after.resultEnvelope.payload.receipts, [receipt])
  assert.equal(dispatches, 1)
})

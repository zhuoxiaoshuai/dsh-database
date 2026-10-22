import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { runOperation } from '../src/host/operation-runtime.ts'
import { connectionApi } from '../src/host/connection-api.ts'
import { executeKnowledgeRequest } from '../src/client/knowledge-sql-request.ts'
import { historyItemsForConnection } from '../src/shared/execution.ts'
import { temporaryDirectory } from './helpers.mjs'

const partial = { columns: [], rows: [], truncated: false, elapsedMs: 1,
  steps: [{ index: 0, sql: 'INSERT INTO a VALUES (1)', status: 'succeeded', affectedRows: 1 },
    { index: 1, sql: 'INSERT INTO b VALUES (2)', status: 'unknown' }, { index: 2, sql: 'INSERT INTO c VALUES (3)', status: 'not-run' }],
  batch: [{ columns: [], rows: [], truncated: false, elapsedMs: 1, affectedRows: 1 }] }
const connection = { id: 'a', generation: 'g1', database: 'app', dialect: 'mysql', live: true }

async function fixture(t, mode) {
  const executions = new ExecutionStore(temporaryDirectory(t, 'knowledge-wire-'))
  let dispatches = 0, accepted, started, release
  const acceptedGate = new Promise(resolve => accepted = resolve), startedGate = new Promise(resolve => started = resolve)
  const service = {
    async executeText(owner, id, generation, text, signal, initiator, callId, _revision, _root, context, options) {
      const outcome = await runOperation(executions, { owner, connectionId: id, generation, sourceId: 'mysql', connectionName: 'fixture', environment: 'sit' },
        { operation: 'knowledge_sql_execute', title: 'Knowledge', initiator, callId, sql: text, schema: context.schema, historyVisible: false },
        async (workSignal, dispatched) => {
          if (mode === 'before-accept') await new Promise(resolve => setTimeout(resolve, 30))
          if (workSignal.aborted) throw Object.assign(Error('Not dispatched'), { effect: 'none', phase: 'check' })
          dispatched(); dispatches++; started()
          if (mode === 'success' || mode === 'missing-accept') return { columns: ['proof'], rows: [[1]], truncated: false, elapsedMs: 1 }
          return await new Promise((resolve, reject) => {
            const cancel = () => {
              if (mode === 'late-success') { resolve({ columns: ['late'], rows: [[1]], truncated: false, elapsedMs: 1 }); return }
              const receipt = mode === 'between-steps' ? { ...partial, steps: partial.steps.map(step => step.status === 'unknown' ? { ...step, status: 'not-run' } : step) } : partial
              const finish = () => reject(Object.assign(Error('Partial unknown'), { effect: 'unknown', phase: 'receipt', ...receipt }))
              if (mode === 'recovery-timeout') { release = finish; return }
              if (mode === 'delayed-settlement') setTimeout(finish, 40)
              else finish()
            }
            workSignal.addEventListener('abort', cancel, { once: true })
            if (workSignal.aborted) cancel()
          })
        }, () => 'Done', signal, undefined, {
          onCreated: id => { options.onCreated(id); accepted(id) }, completedResultIsDefinitive: true,
          classifyInterruption: (error, state) => error?.effect === 'none' ? 'cancelled' : state.dispatched ? 'unknown' : 'failed',
          projectCompletion: result => ({ result }),
        })
      if (outcome.executionStatus === 'unknown') {
        const saved = executions.get(owner, outcome.executionId, true)
        throw Object.assign(Error('Unknown stays unknown'), { effect: 'unknown', phase: 'receipt', executionId: outcome.executionId,
          executionStatus: 'unknown', steps: saved.result?.steps, batch: saved.result?.batch })
      }
      return { executionId: outcome.executionId, status: outcome.executionStatus, result: outcome }
    },
  }
  const server = createServer(async (req, res) => {
    if (['drop-terminal', 'missing-accept', 'between-steps', 'recovery-timeout'].includes(mode)) {
      const write = res.write.bind(res)
      res.write = (chunk, ...args) => {
        const frame = JSON.parse(String(chunk))
        if (frame.type === 'accepted' && mode === 'missing-accept') return true
        if (frame.type === 'accepted' && ['drop-terminal', 'between-steps', 'recovery-timeout'].includes(mode)) {
          const sent = write(chunk, ...args)
          setImmediate(() => res.destroy())
          return sent
        }
        return write(chunk, ...args)
      }
    }
    await connectionApi(service, executions, 'owner', req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const request = async (body, signal) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
    const value = await response.json()
    if (!response.ok) throw Error(value.error)
    return value
  }
  t.after(async () => { release?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); executions.dispose() })
  return { executions, request, endpoint, acceptedGate, startedGate, dispatches: () => dispatches, release: () => release?.() }
}

for (const mode of ['success', 'stop', 'before-accept', 'delayed-settlement', 'drop-terminal', 'missing-accept', 'late-success', 'between-steps']) {
  test(`knowledge SQL transport ${mode} owns receipts without replay or history adoption`, async t => {
    const f = await fixture(t, mode), stop = new AbortController(), lifecycle = new AbortController()
    const run = executeKnowledgeRequest(f.endpoint, f.request, connection, 'INSERT INTO a VALUES (1); INSERT INTO b VALUES (2); INSERT INTO c VALUES (3)', { signal: lifecycle.signal, stopSignal: stop.signal })
    // Attach rejection handling before cancellation can settle the transport.
    const outcome = run.then(value => ({ value }), error => ({ error }))
    const id = await f.acceptedGate
    if (mode === 'before-accept') stop.abort()
    else if (!['success', 'missing-accept', 'drop-terminal', 'between-steps'].includes(mode)) { await f.startedGate; stop.abort() }
    const result = await outcome
    if (['success', 'missing-accept'].includes(mode)) assert.deepEqual(result.value.rows, [[1]])
    else {
      assert.ok(result.error)
      assert.equal(result.error.executionId, id)
      if (mode === 'before-accept') assert.ok(['cancelled', 'unknown'].includes(result.error.executionStatus))
      else assert.equal(result.error.effect, 'unknown')
      if (['stop', 'delayed-settlement', 'drop-terminal'].includes(mode)) {
        assert.deepEqual(result.error.steps.map(step => step.status), ['succeeded', 'unknown', 'not-run'])
        assert.equal(result.error.steps[0].affectedRows, 1)
      }
      if (mode === 'between-steps') assert.deepEqual(result.error.steps.map(step => step.status), ['succeeded', 'not-run', 'not-run'])
    }
    assert.ok(f.dispatches() <= 1)
    assert.equal(f.executions.get('owner', id, true).receiptPending, false)
    assert.equal(f.executions.latestDisplay('owner', 'a'), undefined)
    assert.equal(historyItemsForConnection(f.executions.list('owner'), 'a').length, 0)
    assert.equal(f.executions.knowledgeRequest('other', f.executions.get('owner', id).callId, 'a', 'g1', 'app'), undefined)
    assert.equal(f.executions.knowledgeRequest('owner', f.executions.get('owner', id).callId, 'a', 'g2', 'app'), undefined)
  })
}

test('knowledge SQL already stopped before dispatch never sends a request', async () => {
  const stop = new AbortController(); stop.abort()
  await assert.rejects(executeKnowledgeRequest('http://invalid', () => { throw Error('must not request') }, connection, 'SELECT 1',
    { signal: new AbortController().signal, stopSignal: stop.signal }), error => error.effect === 'none' && error.requestPhase === 'before-fetch')
})

test('knowledge SQL recovery deadline returns unknown without replay or pretending the Host settled', async t => {
  const f = await fixture(t, 'recovery-timeout'), started = Date.now()
  const run = executeKnowledgeRequest(f.endpoint, f.request, connection, 'SELECT 1', { signal: new AbortController().signal, stopSignal: new AbortController().signal })
  const outcome = run.then(value => ({ value }), error => ({ error }))
  const id = await f.acceptedGate, result = await outcome
  assert.equal(result.error.effect, 'unknown'); assert.match(result.error.message, /未能完整恢复/)
  assert.ok(Date.now() - started >= 9800 && Date.now() - started < 15000)
  assert.equal(f.dispatches(), 1); assert.equal(f.executions.get('owner', id).receiptPending, true)
  f.release()
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { ConnectionService } from '../src/host/connection-service.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { registerKafkaAiTools } from '../src/host/data-sources/kafka/ai-tools.ts'
import { temporaryDirectory } from './helpers.mjs'

async function fixture(t, environment = 'sit') {
  const directory = temporaryDirectory(t, 'kafka-lifecycle-'), marker = join(directory, 'dispatch.jsonl')
  const executions = new ExecutionStore(directory), workers = []
  const service = new ConnectionService(() => true, directory, undefined, undefined, executions, undefined, () => {
    const worker = new Worker(new URL('./fixtures/kafka-queue-worker.mjs', import.meta.url), { workerData: { marker } }); workers.push(worker); return worker
  })
  const input = { dialect: 'kafka', name: 'fixture', brokers: ['127.0.0.1:9092'], tls: false, saslMechanism: 'none', environment }
  const connection = await service.open('owner', input, false)
  t.after(async () => { await service.dispose(); executions.dispose() })
  const tools = new Map(), events = [], emit = executions.emitWorkbench.bind(executions)
  executions.emitWorkbench = (owner, event) => { events.push(event); emit(owner, event) }
  registerKafkaAiTools({ tools: { register: tool => tools.set(tool.name, tool) } }, service, executions, id => id === 'owner')
  const invoke = (tool, args = {}, signal) => tools.get(tool).execute({ connectionId: connection.id, generation: connection.generation, ...args },
    { agent: { session: { id: 'owner' } }, callId: 'group-call', rootCallId: 'group-root', signal })
  const dispatched = () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  return { directory, service, input, connection, executions, events, invoke, dispatched,
    release() { for (const worker of workers) try { worker.postMessage({ fixtureRelease: true }) } catch { /* old worker terminated */ } } }
}
async function waitFor(check) {
  const until = Date.now() + 5000
  while (!check()) { assert.ok(Date.now() < until); await new Promise(done => setTimeout(done, 5)) }
}
const cases = [
  ['kafka_groups', {}, 'kafka_groups'], ['kafka_group', { groupId: 'billing' }, 'kafka_group'],
  ['kafka_group_topics', { groupId: 'billing' }, 'kafka_group-topics'], ['kafka_group_topic', { groupId: 'billing', topic: 'orders' }, 'kafka_group-topic'],
]

test('Kafka publish uses one SIT lifecycle, while UAT rejects AI and manual sends before Worker dispatch', async t => {
  const sit = await fixture(t, 'sit')
  const result = JSON.parse(await sit.invoke('kafka_produce', { topic: 'demo', key: 'case-1', value: 'hello' }))
  assert.equal(result.executionStatus, 'succeeded')
  assert.equal(result.baseOffset, '42')
  const record = sit.executions.get('owner', result.executionId)
  assert.equal(record.operation, 'kafka_produce')
  assert.equal(record.events.filter(event => event.kind === 'dispatched').length, 1)
  assert.equal(sit.events.filter(event => event.type === 'EXECUTION_FINISHED' && event.executionId === result.executionId).length, 1)
  assert.equal(sit.dispatched().filter(item => item.action === 'kafka-produce').length, 1)
  assert.ok(!readFileSync(join(sit.directory, 'ai-executions.json'), 'utf8').includes('hello'))

  const uat = await fixture(t, 'uat')
  await assert.rejects(uat.invoke('kafka_produce', { topic: 'demo', value: 'hello' }), /SIT/)
  await assert.rejects(uat.service.executeText('owner', uat.connection.id, uat.connection.generation,
    'PRODUCE {"topic":"demo","value":"hello"}'), /SIT/)
  assert.equal(uat.dispatched().length, 0)
})

test('Kafka send cancelled after dispatch remains unknown and is not replayed', async t => {
  const f = await fixture(t, 'sit')
  const abort = new AbortController()
  const pending = f.service.executeText('owner', f.connection.id, f.connection.generation,
    'PRODUCE {"topic":"demo","value":"HANG_RECEIPT"}', abort.signal)
  await waitFor(() => f.dispatched().some(item => item.action === 'kafka-produce'))
  abort.abort()
  await assert.rejects(pending, /核对目标 Topic/)
  const record = f.executions.list('owner').find(item => item.operation === 'kafka_produce')
  assert.equal(record.status, 'unknown')
  assert.equal(f.dispatched().filter(item => item.action === 'kafka-produce').length, 1)
})
for (const [tool, args, operation] of cases) for (const change of ['takeover', 'text', 'generation', 'cancel']) test(`queued ${tool} rejects ${change} with no dispatch or duplicate lifecycle`, async t => {
  const f = await fixture(t)
  const blockers = Array.from({ length: 3 }, () => f.service.executeText('owner', f.connection.id, f.connection.generation, 'DESCRIBE "BLOCK"').catch(error => error))
  await waitFor(() => f.dispatched().length === 3)
  const abort = new AbortController()
  const pending = f.invoke(tool, args, abort.signal)
  const rejected = assert.rejects(pending)
  await waitFor(() => f.executions.list('owner').some(record => record.operation === operation))
  if (change === 'takeover') f.service.controlExecutionDocument('owner', f.connection.id, 'user', undefined, f.connection.generation, f.service.getExecutionDocument('owner', f.connection.id).revision)
  if (change === 'text') f.service.updateExecutionDocument('owner', f.connection.id, 'TOPICS', 'ai', f.service.getExecutionDocument('owner', f.connection.id).revision, f.connection.generation)
  if (change === 'generation') await f.service.open('owner', f.input, false, f.connection.id)
  if (change === 'cancel') abort.abort()
  f.release(); await Promise.allSettled(blockers); await rejected
  const records = f.executions.list('owner').filter(record => record.operation === operation)
  assert.equal(records.length, 1); assert.ok(['failed', 'cancelled', 'unknown'].includes(records[0].status))
  assert.equal(records[0].events.filter(event => event.kind === 'dispatched').length, 0)
  assert.equal(f.dispatched().length, 3)
})

for (const environment of ['sit', 'uat', 'pvt']) test(`Kafka group tools in ${environment} use one tool record and one truthful document event`, async t => {
  const f = await fixture(t, environment)
  for (const [tool, args] of cases) {
    const reply = JSON.parse(await f.invoke(tool, args))
    const record = f.executions.get('owner', reply.executionId)
    assert.equal(record.callId, 'group-call'); assert.equal(record.rootCallId, 'group-root'); assert.equal(record.type, 'tool')
    assert.equal(record.status, 'succeeded'); assert.equal(record.events.filter(event => event.kind === 'dispatched').length, 1)
    const event = f.events.filter(event => event.type === 'EXECUTION_FINISHED' && event.executionId === reply.executionId)
    assert.equal(event.length, 1); assert.equal(event[0].status, record.status)
    assert.equal(event[0].generation, f.connection.generation)
  }
  assert.equal(f.executions.list('owner').length, 4)
  assert.ok(!readFileSync(join(f.directory, 'ai-executions.json'), 'utf8').includes('PRIVATE_PAYLOAD'))
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { registerKafkaAiTools } from '../src/host/data-sources/kafka/ai-tools.ts'

function fixture() {
  const tools = new Map(), events = []
  let document = { sourceId: 'kafka', text: '', revision: 0, controller: 'ai' }
  let dispatched = 0
  const connection = { id: 'k1', dialect: 'kafka', generation: 'g1', live: true, name: 'test', environment: 'pvt' }
  const service = {
    list: () => [connection], restoreRemembered: async () => {},
    getExecutionDocument: () => document,
    updateExecutionDocument: (_session, _id, text, source, expected) => {
      assert.equal(source, 'ai')
      assert.equal(expected, document.revision)
      document = { ...document, text, revision: document.revision + 1 }
      return document
    },
    executeText: async (_session, id, generation, text, _signal, initiator, callId, revision) => {
      dispatched += 1
      assert.deepEqual([id, generation, initiator, callId, revision], ['k1', 'g1', 'ai', 'call-1', document.revision])
      assert.equal(text, document.text)
      return { kind: 'topics', topics: ['demo'], executionId: 'execution-1' }
    },
  }
  const executions = { emitWorkbench: (_session, event) => events.push(event) }
  registerKafkaAiTools({ tools: { register: tool => tools.set(tool.name, tool) } }, service, executions, id => id === 'owner')
  const execution = { callId: 'call-1', agent: { session: { id: 'owner' } } }
  return { tools, events, service, execution, connection, get document() { return document }, set document(value) { document = value },
    get dispatched() { return dispatched } }
}

test('Kafka AI publishes the exact read command and returns one execution ID', async () => {
  const state = fixture()
  assert.deepEqual([...state.tools.keys()], ['kafka_status', 'kafka_topics', 'kafka_describe', 'kafka_peek'])
  const reply = JSON.parse(await state.tools.get('kafka_topics').execute({ connectionId: 'k1', generation: 'g1' }, state.execution))
  assert.equal(state.document.text, 'TOPICS')
  assert.equal(reply.executionId, 'execution-1')
  assert.equal(state.dispatched, 1)
  assert.equal(state.events[0].queryRevision, state.document.revision)
})

test('Kafka AI refuses takeover, stale generation and unsupported command parameters', async () => {
  const state = fixture()
  state.document = { ...state.document, controller: 'user' }
  await assert.rejects(state.tools.get('kafka_topics').execute({ connectionId: 'k1', generation: 'g1' }, state.execution), /接管/)
  assert.equal(state.dispatched, 0)
  state.document = { ...state.document, controller: 'ai' }
  await assert.rejects(state.tools.get('kafka_peek').execute({ connectionId: 'k1', generation: 'wrong',
    topic: 'demo', partition: 0, from: 'latest' }, state.execution), /连接已变化/)
  await assert.rejects(state.tools.get('kafka_peek').execute({ connectionId: 'k1', generation: 'g1',
    topic: 'demo', partition: 0, from: 'latest', limit: 201 }, state.execution), /LIMIT/)
  assert.equal(state.dispatched, 0)
})

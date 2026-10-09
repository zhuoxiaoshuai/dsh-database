import test from 'node:test'
import assert from 'node:assert/strict'
import { registerKafkaAiTools } from '../src/host/data-sources/kafka/ai-tools.ts'

function fixture() {
  const tools = new Map(), events = []
  let document = { sourceId: 'kafka', text: '', revision: 0, controller: 'ai' }
  let dispatched = 0
  const connection = { id: 'k1', dialect: 'kafka', generation: 'g1', live: true, name: 'test', environment: 'pvt' }
  const connections = [connection]
  const service = {
    list: () => connections, restoreRemembered: async () => {},
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
  return { tools, events, service, execution, connection, connections, get document() { return document }, set document(value) { document = value },
    get dispatched() { return dispatched } }
}

test('Kafka AI publishes the exact read command and returns one execution ID', async () => {
  const state = fixture()
  assert.deepEqual([...state.tools.keys()], ['kafka_status', 'kafka_topics', 'kafka_describe', 'kafka_peek', 'kafka_groups', 'kafka_group', 'kafka_group_topics', 'kafka_group_topic',
    'kafka_topic_config', 'kafka_time_offsets', 'kafka_scan', 'kafka_produce', 'kafka_produce_batch', 'kafka_tombstone', 'kafka_create_topic', 'kafka_set_group_offsets'])
  const reply = JSON.parse(await state.tools.get('kafka_topics').execute({ connectionId: 'k1', generation: 'g1' }, state.execution))
  assert.equal(state.document.text, 'TOPICS')
  assert.equal(reply.executionId, 'execution-1')
  assert.equal(state.dispatched, 1)
  assert.equal(state.events.length, 0, 'tool delegates document result events to the service lifecycle')
})

test('Kafka AI produce refuses PVT before changing the document and sends canonical SIT text', async () => {
  const state = fixture()
  const args = { connectionId: 'k1', generation: 'g1', topic: 'demo', key: 'case-1', value: 'hello' }
  await assert.rejects(state.tools.get('kafka_produce').execute(args, state.execution), /SIT/)
  assert.equal(state.document.revision, 0)
  assert.equal(state.dispatched, 0)
  state.connection.environment = 'sit'
  await state.tools.get('kafka_produce').execute(args, state.execution)
  assert.equal(state.document.text, 'PRODUCE {"topic":"demo","key":"case-1","value":"hello"}')
  assert.equal(state.dispatched, 1)
})

test('Kafka AI can directly execute SIT management writes after canonical validation', async () => {
  const state = fixture()
  const selected = { connectionId: 'k1', generation: 'g1' }
  const create = { ...selected, topic: 'dsh-test-ai', partitions: 1, replicationFactor: 1, cleanupPolicy: 'compact' }
  await assert.rejects(state.tools.get('kafka_create_topic').execute(create, state.execution), /SIT/)
  assert.equal(state.dispatched, 0)
  state.connection.environment = 'sit'
  await state.tools.get('kafka_create_topic').execute(create, state.execution)
  assert.equal(state.document.text, 'CREATE_TOPIC {"topic":"dsh-test-ai","partitions":1,"replicationFactor":1,"cleanupPolicy":"compact"}')
  await state.tools.get('kafka_set_group_offsets').execute({ ...selected,
    spec: { groupId: 'billing', topic: 'dsh-test-ai', expected: { 0: null }, offsets: { 0: '2' } } }, state.execution)
  assert.match(state.document.text, /^SET_GROUP_OFFSETS /)
  assert.equal(state.dispatched, 2)
})

test('Kafka group tools publish real canonical read commands, including list pagination', async () => {
  const state = fixture()
  for (const [tool, input, command] of [
    ['kafka_topics', { search: 'order', cursor: '100' }, 'TOPICS SEARCH "order" CURSOR 100'],
    ['kafka_groups', { search: 'billing', cursor: '100' }, 'GROUPS SEARCH "billing" CURSOR 100'],
    ['kafka_group', { groupId: 'billing' }, 'GROUP "billing"'],
    ['kafka_group_topics', { groupId: 'billing', cursor: '100' }, 'GROUP "billing" TOPICS CURSOR 100'],
    ['kafka_group_topic', { groupId: 'billing', topic: 'orders' }, 'GROUP "billing" TOPIC "orders"'],
  ]) {
    await state.tools.get(tool).execute({ connectionId: 'k1', generation: 'g1', ...input }, state.execution)
    assert.equal(state.document.text, command)
  }
  assert.equal(state.dispatched, 5); assert.equal(state.events.length, 0)
})

test('Kafka AI refuses takeover, stale generation and unsupported command parameters', async () => {
  const state = fixture()
  state.document = { ...state.document, controller: 'user' }
  await assert.rejects(state.tools.get('kafka_topics').execute({ connectionId: 'k1', generation: 'g1' }, state.execution), /接管/)
  assert.equal(state.dispatched, 0)
  state.document = { ...state.document, controller: 'ai' }
  const stale = JSON.parse(await state.tools.get('kafka_peek').execute({ connectionId: 'k1', generation: 'wrong',
    topic: 'demo', partition: 0, from: 'LATEST' }, state.execution))
  assert.equal(stale.ok, false)
  assert.match(stale.error, /generation/)
  assert.equal(stale.connections[0].generation, 'g1')
  assert.match(stale.help, /kafka_status/)
  await assert.rejects(state.tools.get('kafka_peek').execute({ connectionId: 'k1', generation: 'g1',
    topic: 'demo', partition: 0, from: 'LATEST', limit: 201 }, state.execution), /LIMIT/)
  assert.equal(state.dispatched, 0)
})

test('Kafka AI uses the only live connection and lists connections when the choice is ambiguous', async () => {
  const state = fixture()
  const omitted = JSON.parse(await state.tools.get('kafka_topics').execute({}, state.execution))
  assert.equal(omitted.kind, 'topics')
  assert.equal(state.dispatched, 1)
  const filled = JSON.parse(await state.tools.get('kafka_topics').execute({ connectionId: 'k1' }, state.execution))
  assert.equal(filled.kind, 'topics')
  state.connections.push({ id: 'k2', dialect: 'kafka', generation: 'g2', live: true, name: 'other', environment: 'sit' })
  const ambiguous = JSON.parse(await state.tools.get('kafka_topics').execute({}, state.execution))
  assert.equal(ambiguous.ok, false)
  assert.equal(ambiguous.connections.length, 2)
  assert.equal(ambiguous.connections[1].connectionId, 'k2')
  assert.equal(state.dispatched, 2)
})

test('Kafka AI tools take objects for scan, offsets, headers and batch messages', async () => {
  const state = fixture()
  state.connection.environment = 'sit'
  const selected = { connectionId: 'k1', generation: 'g1' }
  await state.tools.get('kafka_scan').execute({ ...selected, spec: {
    topic: 'orders', partitions: [0], offsets: { 0: '1' },
  } }, state.execution)
  assert.match(state.document.text, /^SCAN /)
  await assert.rejects(state.tools.get('kafka_scan').execute({ ...selected, spec: '{"topic":"orders"}' }, state.execution), /object/)
  await state.tools.get('kafka_produce').execute({ ...selected, topic: 'orders', value: 'hello', headers: { trace: 'abc' } }, state.execution)
  assert.match(state.document.text, /"headers":\{"trace":"abc"\}/)
  await state.tools.get('kafka_produce_batch').execute({ ...selected, topic: 'orders', messages: [{ value: 'one' }] }, state.execution)
  assert.match(state.document.text, /^PRODUCE_BATCH /)
  await assert.rejects(state.tools.get('kafka_produce_batch').execute({ ...selected, topic: 'orders', messages: '[]' }, state.execution), /array/)
  await state.tools.get('kafka_peek').execute({ ...selected, topic: 'orders', partition: 0, from: 'OFFSET', offset: '3', limit: 1 }, state.execution)
  assert.match(state.document.text, /FROM OFFSET 3/)
  await assert.rejects(state.tools.get('kafka_peek').execute({ ...selected, topic: 'orders', partition: 0, from: 'end' }, state.execution), /BEGINNING/)
})

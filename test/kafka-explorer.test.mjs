import test from 'node:test'
import assert from 'node:assert/strict'
import { kafkaExplorer } from '../src/host/data-sources/kafka/explorer.ts'

test('Kafka topics are leaves and partitions are not tree children', async () => {
  const transport = { source: async (action) => {
    if (action !== 'kafka-topics') throw new Error(action)
    return { topics: ['orders/a:b'], truncated: false }
  } }
  const page = await kafkaExplorer.list(transport, {})
  assert.equal(page.nodes[0].hasChildren, false)
  assert.equal(page.nodes[0].ref, `topic:${encodeURIComponent('orders/a:b')}`)
  await assert.rejects(kafkaExplorer.list(transport, { parent: page.nodes[0].ref }), /没有子节点/)
})

test('Kafka group tree unions topics without asking for end offsets', async () => {
  const calls = []
  const transport = { source: async (action, input) => {
    calls.push(action)
    if (action === 'kafka-groups') return { groups: ['a/b:c'], truncated: false }
    if (action === 'kafka-group' && input.topics === true) return { topics: ['old', 'orders'] }
    if (action === 'kafka-group' && input.topic) return { kind: 'group-topic', groupId: input.groupId, topic: input.topic, partitions: [{ partition: 0, current: '0', end: '2', lag: '2', consumer: null }] }
    if (action === 'kafka-group') return { kind: 'group', groupId: input.groupId, state: 'Empty', protocol: '', protocolType: 'consumer', members: [] }
    throw new Error(action)
  } }
  const groups = await kafkaExplorer.list(transport, { parent: 'folder:groups' })
  assert.equal(groups.nodes[0].hasChildren, true)
  assert.equal(groups.nodes[0].ref, `group:${encodeURIComponent('a/b:c')}`)
  const topics = await kafkaExplorer.list(transport, { parent: groups.nodes[0].ref })
  assert.deepEqual(topics.nodes.map(node => node.title), ['old', 'orders'])
  assert.equal(topics.nodes.every(node => node.hasChildren === false), true)
  const group = await kafkaExplorer.read(transport, { ref: groups.nodes[0].ref })
  assert.equal(group.kind, 'group')
  assert.equal(Object.hasOwn(group, 'partitions'), false)
  const topic = await kafkaExplorer.read(transport, { ref: topics.nodes[1].ref })
  assert.equal(topic.kind, 'group-topic')
  assert.equal(calls.includes('kafka-describe'), false)
})

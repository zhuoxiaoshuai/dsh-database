import test from 'node:test'
import assert from 'node:assert/strict'
import { AssignerProtocol } from 'kafkajs'
import { committedOffset, groupTopicRows, lagBetween, unionTopicNames, visibleGroupIds } from '../src/host/data-sources/kafka/group.mjs'
import { describeKafkaGroup, describeKafkaGroupTopic, listKafkaGroupTopics, listKafkaGroups } from '../src/host/data-sources/kafka/driver.mjs'

test('committed offset keeps 0 and treats -1 as no commit', () => {
  assert.equal(committedOffset('-1'), null)
  assert.equal(committedOffset(-1), null)
  assert.equal(committedOffset('-1n') , null)
  assert.equal(committedOffset('0'), '0')
  assert.equal(committedOffset(0), '0')
  assert.equal(committedOffset('9007199254740993'), '9007199254740993')
  assert.equal(lagBetween('9007199254740993', '0'), '9007199254740993')
  assert.equal(lagBetween('10', '0'), '10')
  assert.equal(lagBetween('10', null), null)
  assert.equal(typeof lagBetween('10', '0'), 'string')
})

test('group topic rows do not infer a consumer or turn a missing commit into zero lag', () => {
  const missing = groupTopicRows({
    committed: [{ partition: 0, offset: '-1' }],
    assignment: [],
    ends: [{ partition: 0, high: '8' }],
  })
  assert.deepEqual(missing, [{ partition: 0, current: null, end: '8', lag: null, consumer: null }])
  const atZero = groupTopicRows({
    committed: [{ partition: 0, offset: '0' }],
    assignment: [],
    ends: [{ partition: 0, high: '9007199254740993' }],
  })
  assert.equal(atZero[0].current, '0')
  assert.equal(atZero[0].lag, '9007199254740993')
  assert.equal(atZero[0].consumer, null)
  const endFailed = groupTopicRows({
    committed: [{ partition: 1, offset: '4' }],
    assignment: [{ partition: 1, consumer: 'app' }],
    ends: null,
  })
  assert.deepEqual(endFailed, [{ partition: 1, current: '4', end: null, lag: null, consumer: 'app' }])
  assert.deepEqual(unionTopicNames(['orders', 'pay'], ['orders', 'old']), ['old', 'orders', 'pay'])
  assert.deepEqual(visibleGroupIds(['dsh-peek-1', 'app', 'app', '']), ['app'])
})

test('listing a group does not read topic end offsets', async () => {
  const memberAssignment = AssignerProtocol.MemberAssignment.encode({ version: 0, assignment: { orders: [0] }, userData: Buffer.alloc(0) })
  const calls = []
  const runtime = { admin: {
    async listGroups() { return { groups: [{ groupId: 'dsh-peek-temp' }, { groupId: 'app' }, { groupId: 'app' }] } },
    async describeGroups() {
      calls.push('describe')
      return { groups: [{ groupId: 'app', state: 'Stable', protocol: 'range', protocolType: 'consumer', members: [{ memberId: 'm1', clientId: 'app', clientHost: '/1', memberAssignment }] }] }
    },
    async fetchOffsets(input) {
      calls.push(input.topics?.length ? `offsets:${input.topics.join(',')}` : 'offsets:all')
      if (!input.topics?.length) return [{ topic: 'old', partitions: [{ partition: 0, offset: '3' }] }, { topic: 'orders', partitions: [{ partition: 0, offset: '-1' }] }]
      return [{ topic: 'orders', partitions: [{ partition: 0, offset: '0' }] }]
    },
    async fetchTopicOffsets() { calls.push('ends'); throw new Error('end offsets are not available') },
  } }
  const listed = await listKafkaGroups(runtime, {})
  assert.deepEqual(listed.groups, ['app'])
  const described = await describeKafkaGroup(runtime, 'app')
  assert.equal(described.members[0].assignment.orders[0], 0)
  assert.equal(calls.includes('offsets:all') || calls.includes('ends'), false)
  const topics = await listKafkaGroupTopics(runtime, 'app')
  assert.deepEqual(topics.topics, ['old', 'orders'])
  assert.equal(calls.includes('ends'), false)
  const detail = await describeKafkaGroupTopic(runtime, 'app', 'orders')
  assert.equal(calls.includes('ends'), true)
  assert.equal(detail.partitions[0].current, '0')
  assert.equal(detail.partitions[0].end, null)
  assert.equal(detail.partitions[0].lag, null)
  assert.equal(detail.partitions[0].consumer, 'app')
})

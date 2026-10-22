import test from 'node:test'
import assert from 'node:assert/strict'
import { AssignerProtocol } from 'kafkajs'
import { groupTopicRows, summarizePartitions } from '../src/host/data-sources/kafka/group.mjs'
import { describeKafkaGroupTopic, describeKafkaGroup, describeKafkaTopic } from '../src/host/data-sources/kafka/driver.mjs'
import { describeKafkaTopicGroups, describeKafkaGroupSummary, describeKafkaCatalog, cachedKafkaInspection } from '../src/host/data-sources/kafka/inspection.mjs'
import { parseKafkaCommand, formatKafkaCommand } from '../src/host/data-sources/kafka/command.mjs'
import { kafkaExplorer } from '../src/host/data-sources/kafka/explorer.ts'
import { limitKafkaResult } from '../src/host/data-sources/kafka/result.mjs'

const assignment = topics => AssignerProtocol.MemberAssignment.encode({ version: 0, assignment: topics, userData: Buffer.alloc(0) })
const member = (topics, host = '/10.10.1.11') => ({ memberId: 'consumer-1', clientId: 'worker', clientHost: host, memberAssignment: assignment(topics) })
function fixture() {
  const groups = {
    active: { members: [member({ orders: [0] }), { ...member({ orders: [1], pay: [0] }, '/10.20.1.12'), memberId: 'consumer-2' }] },
    fresh: { members: [member({ orders: [0] })] },
    old: { members: [] },
    unrelated: { members: [member({ pay: [0] })] },
  }
  const commits = { active: { orders: ['90', '80'], pay: ['10'] }, old: { orders: ['50', '50'] } }
  return { groups, commits, admin: {
    async listTopics() { return ['orders', 'pay'] },
    async listGroups() { return { groups: [...Object.keys(groups), 'dsh-peek-hidden'].map(groupId => ({ groupId })) } },
    async describeGroups(ids) { return { groups: ids.map(groupId => ({ groupId, state: groups[groupId].members.length ? 'Stable' : 'Empty', ...groups[groupId] })) } },
    async fetchOffsets({ groupId, topics }) {
      const names = topics.length ? topics : Object.keys(commits[groupId] || {})
      return names.map(topic => ({ topic, partitions: (commits[groupId]?.[topic] || []).map((offset, partition) => ({ partition, offset })) }))
    },
    async fetchTopicOffsets(topic) { return (topic === 'orders' ? [0, 1] : [0]).map(partition => ({ partition, low: '0', high: '100' })) },
    async fetchTopicMetadata({ topics }) { return { topics: topics.map(name => ({ name, partitions: [{ partitionId: 0, leader: 1, replicas: [1, 2], isr: [1], offlineReplicas: [] }] })) } },
  } }
}

test('Topic reverse association includes fresh assignments and offline commits but not unrelated or temporary groups', async () => {
  const result = await describeKafkaTopicGroups(fixture(), 'orders')
  assert.equal(result.complete, true)
  assert.deepEqual(result.associations.map(row => [row.groupId, row.assigned, row.committed]), [
    ['active', true, true], ['fresh', true, false], ['old', false, true],
  ])
})

test('Topic reverse scan preserves matches and incompleteness on malformed assignments and per-group ACL failures', async () => {
  const runtime = fixture()
  runtime.groups.fresh.members[0].memberAssignment = Buffer.from('broken')
  const fetch = runtime.admin.fetchOffsets
  runtime.admin.fetchOffsets = input => input.groupId === 'old' ? Promise.reject(new Error('ACL denied')) : fetch(input)
  const result = await describeKafkaTopicGroups(runtime, 'orders')
  assert.equal(result.complete, false); assert.equal(result.failed, 2)
  assert.deepEqual(result.associations.map(row => row.groupId), ['active'])
  const group = await describeKafkaGroup(runtime, 'fresh')
  assert.equal(group.members[0].assignmentKnown, false); assert.equal(group.complete, false)
})

test('Topic reverse scan empty match page keeps candidate cursor and never exceeds four concurrent candidates', async () => {
  const runtime = fixture(); let running = 0, maximum = 0
  runtime.admin.listGroups = async () => ({ groups: Array.from({ length: 101 }, (_, i) => ({ groupId: `g${String(i).padStart(3, '0')}` })) })
  runtime.admin.describeGroups = async ids => { running++; maximum = Math.max(maximum, running); await new Promise(resolve => setTimeout(resolve, 1)); running--; return { groups: ids.map(groupId => ({ groupId, members: [] })) } }
  runtime.admin.fetchOffsets = async ({ groupId }) => groupId === 'g100' ? [{ topic: 'orders', partitions: [{ partition: 0, offset: '0' }] }] : []
  const first = await describeKafkaTopicGroups(runtime, 'orders')
  assert.equal(first.associations.length, 0); assert.equal(first.nextCursor, '100'); assert.equal(first.complete, false); assert.ok(maximum <= 4)
  const last = await describeKafkaTopicGroups(runtime, 'orders', { cursor: first.nextCursor })
  assert.equal(last.complete, true); assert.equal(last.associations[0].groupId, 'g100')
})

test('deadline cursor does not skip stalled candidates; late completion starts no next Admin call', async () => {
  const runtime = fixture(); let resolveFirst, offsets = 0
  const describe = runtime.admin.describeGroups
  runtime.admin.describeGroups = ids => ids[0] === 'active' ? new Promise(resolve => { resolveFirst = resolve }) : describe(ids)
  const fetch = runtime.admin.fetchOffsets
  runtime.admin.fetchOffsets = input => { offsets++; return fetch(input) }
  const result = await describeKafkaTopicGroups(runtime, 'orders', {}, undefined, 15)
  assert.equal(result.complete, false); assert.equal(result.nextCursor, '0')
  const before = offsets
  resolveFirst({ groups: [{ groupId: 'active', members: [] }] })
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(offsets, before)
})

test('reverse query rejects cancellation and broken connections instead of claiming empty associations', async () => {
  const runtime = fixture(), controller = new AbortController(); controller.abort()
  await assert.rejects(describeKafkaTopicGroups(runtime, 'orders', {}, controller.signal), /取消/)
  runtime.admin.describeGroups = async () => { throw Object.assign(new Error('offline'), { name: 'KafkaJSConnectionError' }) }
  await assert.rejects(describeKafkaTopicGroups(runtime, 'orders'), /offline/)
})

test('consumption preserves each assigned host and summarizes independent Topics without adding offsets', async () => {
  const runtime = fixture()
  const detail = await describeKafkaGroupTopic(runtime, 'active', 'orders')
  assert.deepEqual(detail.partitions.map(row => [row.consumerId, row.clientId, row.host, row.lag]), [
    ['consumer-1', 'worker', '/10.10.1.11', '10'], ['consumer-2', 'worker', '/10.20.1.12', '20'],
  ])
  const summary = await describeKafkaGroupSummary(runtime, 'active')
  assert.equal(summary.totalLag, '120'); assert.equal(summary.topics[0].totalLag, '30'); assert.equal(summary.topicCount, 2)
  assert.equal(summary.topics[0].assignedPartitions, 2)
  const fresh = await describeKafkaGroupSummary(runtime, 'fresh')
  assert.equal(fresh.totalLag, null); assert.equal(fresh.uncommittedPartitions, 2)
})

test('range anomalies, missing commits and unreadable offsets never become healthy zero Lag', () => {
  const ends = [0, 1, 2, 3, 4].map(partition => ({ partition, low: '80', high: '100' }))
  const rows = groupTopicRows({ ends, committed: [
    { partition: 0, offset: '120' }, { partition: 1, offset: '10' }, { partition: 2, offset: '-1' },
    { partition: 3, offset: '100' }, { partition: 4, offset: '99', unreadable: true },
  ] })
  assert.deepEqual(rows.map(row => row.status), ['beyond-end', 'before-earliest', 'uncommitted', 'normal', 'unreadable'])
  assert.deepEqual(rows.map(row => row.lag), [null, null, null, '0', null])
  const summary = summarizePartitions(rows)
  assert.equal(summary.totalLag, null); assert.equal(summary.knownLag, '0'); assert.equal(summary.abnormalPartitions, 3)
  assert.equal(summarizePartitions(groupTopicRows({ ends: [{ partition: 0, low: '0', high: '9007199254740993' }], committed: [{ partition: 0, offset: '0' }] })).totalLag, '9007199254740993')
})

test('failed topic metrics produce an explicitly incomplete group summary', async () => {
  const runtime = fixture(), fetch = runtime.admin.fetchTopicOffsets
  runtime.admin.fetchTopicOffsets = topic => topic === 'pay' ? Promise.reject(new Error('ACL')) : fetch(topic)
  const result = await describeKafkaGroupSummary(runtime, 'active')
  assert.equal(result.totalLag, null); assert.equal(result.knownLag, '30'); assert.equal(result.complete, false)
})

test('partial Offset ACL does not hide known assignments, hosts or historical associations', async () => {
  const runtime = fixture(), original = runtime.admin.fetchOffsets
  runtime.admin.fetchOffsets = input => input.groupId === 'active' ? Promise.reject(new Error('Offset ACL')) : original(input)
  const reverse = await describeKafkaTopicGroups(runtime, 'orders')
  assert.equal(reverse.associations.find(item=>item.groupId==='active').assigned,true)
  assert.equal(reverse.associations.find(item=>item.groupId==='active').complete,false)
  const detail = await describeKafkaGroupTopic(runtime, 'active', 'orders')
  assert.equal(detail.complete,false)
  assert.ok(detail.partitions.every(row=>row.host && row.end==='100' && row.status==='unreadable' && row.lag===null))
  const summary = await describeKafkaGroupSummary(runtime, 'active')
  assert.equal(summary.totalLag,null); assert.equal(summary.topics.length,2)
  const describe = runtime.admin.describeGroups
  runtime.admin.describeGroups = ids => ids[0]==='old' ? Promise.reject(new Error('Describe ACL')) : describe(ids)
  const historical = await describeKafkaTopicGroups(runtime, 'orders')
  assert.equal(historical.associations.find(item=>item.groupId==='old').committed,true)
  assert.equal(historical.associations.find(item=>item.groupId==='old').complete,false)
})

test('topic detail and list carry ISR health while list never queries consumption', async () => {
  const runtime = fixture()
  runtime.admin.listGroups = async () => { throw new Error('must not scan groups') }
  const detail = await describeKafkaTopic(runtime, 'orders')
  assert.deepEqual(detail.partitions[0].isr, [1]); assert.equal(detail.partitions[0].health, '副本未同步')
  const list = await describeKafkaCatalog(runtime, 'topics', {}, undefined)
  assert.equal(list.metadata.orders.health, '异常'); assert.equal(list.metadata.orders.replicationFactor, '2')
  runtime.admin.fetchTopicOffsets = async () => { throw new Error('ACL') }
  const partial = await describeKafkaTopic(runtime, 'orders')
  assert.equal(partial.complete, false); assert.equal(partial.partitions[0].health, '副本未同步'); assert.equal(partial.partitions[0].high, '')
  runtime.admin.fetchTopicOffsets = async () => { throw Object.assign(new Error('offline'), { name:'KafkaJSConnectionError' }) }
  await assert.rejects(describeKafkaTopic(runtime, 'orders'), /offline/)
})

test('inspection cache isolates runtimes, honors refresh, expires and does not cache incomplete or failed results', async () => {
  const first = {}, second = {}; let calls = 0
  const action = async () => ({ complete: true, serial: ++calls })
  assert.equal((await cachedKafkaInspection(first, 'a', false, undefined, action)).serial, 1)
  assert.equal((await cachedKafkaInspection(first, 'a', false, undefined, action)).serial, 1)
  assert.equal((await cachedKafkaInspection(second, 'a', false, undefined, action)).serial, 2)
  assert.equal((await cachedKafkaInspection(first, 'a', true, undefined, action)).serial, 3)
  const now = Date.now; Date.now = () => now() + 16000
  try { assert.equal((await cachedKafkaInspection(first, 'a', false, undefined, action)).serial, 4) } finally { Date.now = now }
  const partial = async () => ({ complete: false, serial: ++calls })
  await cachedKafkaInspection(first, 'partial', false, undefined, partial)
  assert.equal((await cachedKafkaInspection(first, 'partial', false, undefined, partial)).serial, 6)
  await assert.rejects(cachedKafkaInspection(first, 'fail', false, undefined, async () => { throw new Error('ACL') }), /ACL/)
  assert.equal((await cachedKafkaInspection(first, 'fail', false, undefined, action)).serial, 7)
})

test('TOPIC_GROUPS command and Explorer preserve safe targets, cursors and refresh', async () => {
  const operation = { kind: 'topic-groups', topic: 'a/b:c', cursor: '100' }
  assert.deepEqual(parseKafkaCommand(formatKafkaCommand(operation)), operation)
  assert.throws(() => parseKafkaCommand('TOPIC_GROUPS "a" CURSOR -1'))
  const calls = [], transport = { async request(action, input) { calls.push([action, input]); return {} } }
  await kafkaExplorer.read(transport, { ref: `topic-groups:${encodeURIComponent(operation.topic)}`, cursor: '100', refresh: true })
  assert.deepEqual(calls[0], ['kafka-topic-groups', { topic: 'a/b:c', cursor: '100', refresh: true }])
  await kafkaExplorer.read(transport, { ref: 'group-summary:app', refresh: true })
  assert.deepEqual(calls[1], ['kafka-group', { groupId: 'app', summary: true, refresh: true }])
})

test('size truncation invalidates aggregate completeness and never leaves a definitive total', () => {
  const result = limitKafkaResult({ kind: 'group-summary', complete: true, totalLag: '0', topics: Array.from({length:100}, (_, i) => ({topic: `${i}${'x'.repeat(20000)}`})) })
  assert.equal(result.resultTruncated, true); assert.equal(result.complete, false); assert.equal(result.totalLag, null)
})

test('cache refuses truncated results and evicts by both entry count and total bytes', async () => {
  const runtime = {}, partialRuntime = {}; let calls = 0
  const oversized = async () => ({ kind: 'group-summary', complete: true, totalLag: '0', topics: Array.from({length:100}, (_, i) => ({topic:`${i}${'x'.repeat(20000)}`})) })
  const read = async () => { calls++; return oversized() }
  await cachedKafkaInspection(partialRuntime, 'large', false, undefined, read)
  await cachedKafkaInspection(partialRuntime, 'large', false, undefined, read)
  assert.equal(calls, 2)
  for (let i = 0; i < 101; i++) await cachedKafkaInspection(runtime, String(i), false, undefined, async () => ({complete:true, serial:i}))
  const evicted = await cachedKafkaInspection(runtime, '0', false, undefined, async () => ({complete:true, serial:'reloaded'}))
  assert.equal(evicted.serial, 'reloaded')
  const byteRuntime = {}
  for (let i = 0; i < 10; i++) await cachedKafkaInspection(byteRuntime, String(i), false, undefined, async () => ({complete:true, message:'x'.repeat(950000)}))
  const bytesEvicted = await cachedKafkaInspection(byteRuntime, '0', false, undefined, async () => ({complete:true, serial:'reloaded'}))
  assert.equal(bytesEvicted.serial, 'reloaded')
})

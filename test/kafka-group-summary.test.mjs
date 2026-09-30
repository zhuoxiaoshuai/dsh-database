import test from 'node:test'
import assert from 'node:assert/strict'
import { kafkaGroupSummary } from '../src/client/kafka/group-summary.ts'

test('消费组标题带分配策略和人数，空策略不占一段', () => {
  assert.equal(kafkaGroupSummary({ state: 'Stable', protocolType: 'consumer', protocol: 'range', members: [{}, {}] }), 'Stable · consumer · range · 2 个成员')
  assert.equal(kafkaGroupSummary({ state: 'Empty', protocolType: 'consumer', protocol: '', members: [] }), 'Empty · consumer · 0 个成员')
  assert.equal(kafkaGroupSummary({ state: '', protocolType: '', protocol: '', members: [] }), '未知状态 · 0 个成员')
})

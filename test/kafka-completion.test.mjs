import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import { createKafkaCompletionSource, kafkaCompletionSlot, kafkaHelp } from '../src/client/kafka/completion.ts'
import { mergeKafkaNames } from '../src/client/kafka/name-cache.ts'
import { kafkaJsonPreview, kafkaExportText } from '../src/client/kafka/message-view.ts'

const source = createKafkaCompletionSource(() => ({ topics: ['orders', 'order "quoted"', 'a\\b'], groups: ['billing'] }))
const complete = (text, pos = text.length) => source(new CompletionContext(EditorState.create({ doc: text }), pos, true))

test('Kafka completion follows JSON tokens and exact parameter positions', () => {
  for (const [text, labels] of [
    ['', ['TOPICS', 'DESCRIBE', 'PEEK', 'GROUPS', 'GROUP', 'PRODUCE', 'PRODUCE_BATCH', 'TOMBSTONE', 'CREATE_TOPIC', 'SET_GROUP_OFFSETS', 'TOPIC_CONFIG', 'TIME_OFFSETS', 'SCAN']],
    ['PEEK "with spaces" ', ['PARTITION']], ['PEEK "x" PARTITION ', []],
    ['PEEK "x" PARTITION 0 ', ['FROM']], ['PEEK "x" PARTITION 0 FROM ', ['BEGINNING', 'LATEST', 'OFFSET']],
    ['PEEK "x" PARTITION 0 FROM OFFSET ', []], ['PEEK "x" PARTITION 0 FROM OFFSET 1 ', ['LIMIT']],
    ['GROUP "billing" ', ['TOPIC', 'TOPICS']], ['GROUP "billing" TOPICS ', ['CURSOR']],
    ['TOPICS SEARCH "order events" ', ['CURSOR']], ['TOPICS CURSOR ', []],
  ]) assert.deepEqual((complete(text)?.options || []).map(item => item.label), labels, text)
  for (const item of kafkaHelp) assert.match(item.help + item.detail, /[\u4e00-\u9fff]/u)
})

test('Kafka name candidates replace only the current parameter, with safe JSON escaping', () => {
  assert.equal(complete('GROUP ')?.options[0].apply, '"billing"')
  const text = 'PEEK "ordzz" PARTITION 0 FROM LATEST'
  const result = complete(text, text.indexOf('zz'))
  assert.equal(result.from, 5); assert.equal(result.to, 12)
  const quoted = result.options.find(item => item.label === 'order "quoted"')
  const applied = text.slice(0, result.from) + quoted.apply + text.slice(result.to)
  assert.equal(applied, 'PEEK "order \\"quoted\\"" PARTITION 0 FROM LATEST'.replaceAll('\\\\', '\\'))
  assert.ok(complete('DESCRIBE "ord')?.options.length)
  assert.equal(complete('DESCRIBE "bad\\'), null)
  assert.equal(kafkaCompletionSlot('UNKNOWN "x" ', 12)?.names, undefined)
})

test('Kafka name cache is bounded, deduplicated and excludes temporary groups', () => {
  const empty = { topics: [], groups: [] }
  const cached = mergeKafkaNames(empty, { topics: ['orders', 'orders'], groups: ['billing', 'dsh-peek-private'] })
  assert.deepEqual(cached, { topics: ['orders'], groups: ['billing'] })
  assert.equal(mergeKafkaNames(cached, { topics: ['orders'] }), cached)
  assert.equal(mergeKafkaNames(empty, { topics: Array.from({ length: 6000 }, (_, i) => String(i)) }).topics.length, 5000)
  const limited = mergeKafkaNames(empty, { topics: Array.from({ length: 5000 }, (_, i) => `${i}${'名'.repeat(100)}`), groups: ['billing'] })
  assert.ok(new TextEncoder().encode([...limited.topics, ...limited.groups].join('')).length <= 1048576)
})

test('Kafka JSON is only a display of complete text; export retains limited original bytes', () => {
  const value = { kind: 'text', text: '{"a":1}', length: 7 }
  assert.equal(kafkaJsonPreview(value), '{\n  "a": 1\n}')
  const exact = kafkaJsonPreview({ kind: 'text', text: '{"id":9007199254740993,"a":1,"a":2}', length: 37 })
  assert.ok(exact.includes('9007199254740993'))
  assert.equal((exact.match(/"a"/g) || []).length, 2, 'JSON view preserves original tokens, including duplicate keys')
  assert.equal(kafkaJsonPreview({ ...value, truncated: true }), undefined)
  assert.equal(kafkaJsonPreview({ kind: 'binary', base64: '/w==', length: 1 }), undefined)
  const result = { messages: [{ value: { kind: 'binary', base64: '/w==', length: 50000, truncated: true } }], complete: false, reason: 'bytes' }
  assert.deepEqual(JSON.parse(kafkaExportText(result)).result, result)
})

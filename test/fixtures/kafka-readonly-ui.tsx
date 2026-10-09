import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { StandardSourceMount } from '../../src/client/workspace-sources.tsx'
import { kafkaModule } from '../../src/client/data-sources/kafka.tsx'
import '../../src/client/style.css'

const state = { runs: 0, childCalls: 0, calls: [] as any[], delayed: false, release: undefined as undefined | ((page: unknown) => void) }
let document = { sourceId: 'kafka', text: '', context: {}, revision: 1, controller: 'ai' }
const topics = [{ ref: 'topic:orders', title: 'orders', kind: 'topic', hasChildren: false }]
const group = { ref: 'group:billing', title: 'billing', kind: 'group', hasChildren: true }
const peek = { kind: 'peek', topic: 'orders', partition: 0, start: '0', high: '3', low: '0', complete: false, reason: 'limit', messages: [
  { offset: '0', timestamp: '1', key: { kind: 'null', length: 0 }, value: { kind: 'text', length: 7, text: '{"a":1}' }, headers: {} },
  { offset: '1', timestamp: '2', key: { kind: 'text', length: 0, text: '' }, value: { kind: 'binary', length: 99999, base64: '/w==', truncated: true }, headers: {} },
] }
const run = async (text: string) => {
  state.runs += 1
  if (text.startsWith('PRODUCE_BATCH')) return { kind: 'produce-batch', topic: 'orders', status: 'succeeded', receipts: [
    { index: 0, partition: 0, baseOffset: '43', valueBytes: 1, acknowledged: true },
  ] }
  if (text.startsWith('TOMBSTONE')) return { kind: 'tombstone', topic: 'orders', partition: 0, baseOffset: '44', acknowledged: true }
  if (text.startsWith('CREATE_TOPIC')) return { kind: 'create-topic', topic: 'dsh-test-ui', partitionCount: 1, replicationFactor: 1, cleanupPolicy: 'compact', acknowledged: true }
  if (text.startsWith('SET_GROUP_OFFSETS')) return { kind: 'set-group-offsets', groupId: 'billing', topic: 'orders', partitions: [{ partition: 0, previous: '1', target: '0', committed: '0' }] }
  if (text.startsWith('SCAN')) return { kind: 'scan', topic: 'orders', partitions: [0], messages: [], inspected: 1, nextOffsets: { 0: '1' }, complete: false, reason: 'limit' }
  if (text.startsWith('PRODUCE')) return { kind: 'produce', topic: 'orders', partition: 0, baseOffset: '42', valueBytes: 5, acknowledged: true }
  if (text.startsWith('PEEK')) return peek
  if (text.startsWith('TOPICS')) return { kind: 'topics', topics: ['orders'], truncated: true, nextCursor: '100', search: 'order' }
  return { kind: 'group', groupId: 'billing', state: 'Empty', members: [] }
}
const bridge = {
  mode: 'host', tables: () => [], catalog: async () => ({ items: [] }), executeText: (_connection: unknown, text: string) => run(text),
  explorer: async (_connection: unknown, action: string, input: any) => {
    state.calls.push({ action, input })
    if (action === 'read') return input.ref.startsWith('group:') ? { kind: 'group', groupId: 'billing', state: 'Empty', members: [] }
      : { kind: 'describe', topic: 'orders', partitions: [{ partition: 0, leader: 1, low: '0', high: '3', replicas: [1] }] }
    if (input.parent === 'folder:groups') return { sourceId: 'kafka', nodes: [group], complete: true }
    if (input.parent === 'group:billing') {
      state.childCalls += 1
      if (state.delayed) { state.delayed = false; return new Promise(resolve => { state.release = resolve }) }
      return { sourceId: 'kafka', nodes: [{ ref: 'gtopic:billing:orders', title: 'orders', kind: 'group-topic', hasChildren: false }], complete: true }
    }
    return { sourceId: 'kafka', nodes: String((_connection as any).generation).endsWith('x') ? [{ ref: 'topic:fresh', title: 'fresh', kind: 'topic', hasChildren: false }] : topics, complete: true }
  },
  executions: async (action: string, input: any) => {
    if (action === 'execution-wait') { await new Promise(resolve => setTimeout(resolve, 300)); return { items: [], events: [], revision: 0 } }
    if (action === 'execution-document-get') return { document }
    if (action === 'execution-document-update') { document = { ...document, text: input.text, revision: document.revision + 1, controller: 'user' }; return { document } }
    if (action === 'execution-document-control') { document = { ...document, controller: input.controller, revision: document.revision + 1 }; return { document } }
    if (action === 'execution-document-run') return run(document.text)
    return { items: [] }
  },
  templates: async (action: string, input: any) => action === 'knowledge-search' ? { items: [] }
    : { id: 'k1', text: input.text, title: input.title || '测试经验', summary: '', tags: [], version: 1, analysis: { operation: 'PEEK' } },
}
function Fixture() {
  const [generation, setGeneration] = useState('g1'), [catalogRoot, setRoot] = useState('topics'), [refreshToken, refresh] = useState(0)
  const connection = { id: 'k1', generation, dialect: 'kafka', name: 'Kafka fixture', environment: 'sit', database: '', live: true, health: 'ready' }
  ;(window as any).kafkaFixture = { state, delayChildren: () => { state.delayed = true }, releaseOld: () => state.release?.({ sourceId: 'kafka', nodes: [{ ref: 'gtopic:billing:old', title: 'STALE_OLD_TOPIC', kind: 'group-topic' }], complete: true }) }
  return <><header style={{ height: 40 }}>
    <button onClick={() => setRoot('topics')}>Topic视图</button><button onClick={() => setRoot('groups')}>消费组视图</button>
    <button onClick={() => refresh(value => value + 1)}>刷新作用域</button><button onClick={() => { document = { ...document, text: '', revision: 1 }; setGeneration(value => value + 'x') }}>模拟重连</button>
  </header><div className="db-workbench" style={{ height: 'calc(100vh - 40px)' }}><StandardSourceMount module={kafkaModule} context={{ host: bridge, connection, catalogRoot, refreshToken } as any} /></div></>
}
createRoot(window.document.getElementById('app')!).render(<Fixture />)

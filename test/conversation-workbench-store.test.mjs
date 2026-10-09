import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConversationWorkbenchStore, hashConversationId } from '../src/host/conversation-workbench-store.ts'
import { temporaryDirectory } from './helpers.mjs'

function makeStore(t) {
  const root = temporaryDirectory(t, 'conv-wb-')
  return { store: new ConversationWorkbenchStore(root), root }
}

const sharedQuery = overrides => ({ sql: 'SELECT 1', controller: 'user', revision: 3, ...overrides })

test('save resets session-scoped fields in the snapshot but keeps live state in memory', t => {
  const { store, root } = makeStore(t)
  const layout = {
    workbenches: { 'conn-1': { sharedQuery: sharedQuery() } },
  }
  store.save('session-a', layout, new Set(['conn-1']))
  // 磁盘快照：控制权回 AI，内容字段保留
  const disk = JSON.parse(readFileSync(join(root, 'conversation-workbenches', `${hashConversationId('session-a')}.json`), 'utf8'))
  assert.equal(disk.workbenches['conn-1'].sharedQuery.controller, 'ai')
  assert.equal(disk.workbenches['conn-1'].sharedQuery.sql, 'SELECT 1')
  assert.equal(disk.workbenches['conn-1'].sharedQuery.revision, 3)
  assert.equal(disk.openIds, undefined)
  assert.equal(disk.lastActiveId, undefined)
  // 内存缓存：真实状态保留
  const live = store.load('session-a').workbenches['conn-1'].sharedQuery
  assert.equal(live.controller, 'user')
})

test('load resets session-scoped fields from a legacy snapshot', t => {
  const { store, root } = makeStore(t)
  const path = join(root, 'conversation-workbenches', `${hashConversationId('session-b')}.json`)
  mkdirSync(join(root, 'conversation-workbenches'), { recursive: true })
  writeFileSync(path, JSON.stringify({
    version: 1,
    openIds: ['conn-1'],
    workbenches: { 'conn-1': { sharedQuery: sharedQuery({ controller: 'user' }) } },
  }))
  const loaded = store.load('session-b').workbenches['conn-1'].sharedQuery
  assert.equal(loaded.controller, 'ai')
})

test('load hits the in-memory cache and skips disk rereads', t => {
  const { store, root } = makeStore(t)
  const first = store.load('session-c')
  // 磁盘被外部改写后缓存命中：不再读盘
  const path = join(root, 'conversation-workbenches', `${hashConversationId('session-c')}.json`)
  mkdirSync(join(root, 'conversation-workbenches'), { recursive: true })
  writeFileSync(path, JSON.stringify({ version: 1, openIds: ['other'], workbenches: {} }))
  const second = store.load('session-c')
  assert.deepEqual(second, first)
  second.workbenches.injected = {}
  assert.deepEqual(store.load('session-c').workbenches, {})
  assert.deepEqual(first.workbenches, {})
})

test('Redis AI document keeps ordinary text but never writes known credentials', t => {
  const { store, root } = makeStore(t)
  const base = { sourceId: 'redis', context: { database: '0' }, controller: 'user', revision: 2 }
  const layout = { workbenches: { 'conn-1': { aiDocument: { ...base, text: 'AUTH user secret' } } } }
  store.save('session-d', layout, new Set(['conn-1']))
  const path = join(root, 'conversation-workbenches', `${hashConversationId('session-d')}.json`)
  const disk = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(disk.workbenches['conn-1'].aiDocument.text, '')
  assert.equal(disk.workbenches['conn-1'].aiDocument.controller, 'user')
  assert.equal(store.load('session-d').workbenches['conn-1'].aiDocument.text, 'AUTH user secret')
  layout.workbenches['conn-1'].aiDocument.text = 'GET customer:1'
  store.save('session-d', layout, new Set(['conn-1']))
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).workbenches['conn-1'].aiDocument.text, 'GET customer:1')
})

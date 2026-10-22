import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SqlTemplateStore } from '../src/host/sql-template-store.ts'
import { temporaryDirectory } from './helpers.mjs'

const connectionId = '11111111-1111-4111-8111-111111111111'
const create = (store, dialect = 'mysql') => store.publish({ connectionId, dialect, action: 'create', title: 'Original', sql: 'SELECT id FROM orders' })
for (const dialect of ['mysql', 'oracle']) test(`${dialect} obsolete family base rejects publish and metadata merge after tidy approval`, async t => {
  const store = new SqlTemplateStore(temporaryDirectory(t, 'knowledge-family-'))
  const first = await create(store, dialect)
  await store.whenIdle()
  const batch = store.proposeTidy({ connectionId, sourceId: dialect, changes: [{ id: first.id, kind: 'update', sql: 'SELECT id, status FROM orders', title: 'Approved' }] })
  assert.equal((await store.applyTidy(connectionId, batch.id)).applied.length, 1)
  for (const action of ['newVersion', 'mergeMeta']) await assert.rejects(store.publish({ connectionId, dialect, action, targetId: first.id, expectedVersion: 1, sql: 'SELECT id, name FROM orders', title: 'Stale' }), /已被其他人更新/)
  assert.equal(store.ensure().templates.length, 2)
  assert.equal(store.search('', dialect, connectionId)[0].title, 'Approved')
})

test('concurrent SQL parses cannot allocate two versions from the same base', async t => {
  const store = new SqlTemplateStore(temporaryDirectory(t, 'knowledge-race-'))
  const first = await create(store)
  await store.whenIdle()
  const replies = await Promise.allSettled(['name', 'status'].map(column => store.publish({ connectionId, dialect: 'mysql', action: 'newVersion', targetId: first.id, expectedVersion: first.version, title: column, sql: `SELECT id, ${column} FROM orders` })))
  assert.equal(replies.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(replies.filter(row => row.status === 'rejected').length, 1)
  assert.deepEqual(store.ensure().templates.map(row => row.version), [1, 2])
})

test('SQL editor snapshot detects metadata-only approval without advancing body version', async t => {
  const store = new SqlTemplateStore(temporaryDirectory(t, 'knowledge-snapshot-'))
  const first = await create(store)
  await store.whenIdle()
  const loaded = store.get(first.id)
  const batch = store.proposeTidy({ connectionId, sourceId: 'mysql', changes: [{ id: first.id, kind: 'update', title: 'Approved metadata' }] })
  await store.applyTidy(connectionId, batch.id)
  assert.equal(store.get(first.id).version, 1)
  await assert.rejects(store.dispatch({ action: 'template-publish', connectionId, dialect: 'mysql', publishAction: 'newVersion', targetId: first.id, expectedVersion: 1,
    expectedSnapshot: { text: loaded.originalSql, title: loaded.title, summary: loaded.summary, tags: loaded.tags }, sql: 'SELECT id, name FROM orders', title: 'Old metadata' }), /已被其他人更新/)
  assert.equal(store.ensure().templates.length, 1)
})

for (const count of [49, 50, 51, 100]) test(`knowledge restart preserves ${count} published items and pending batches`, t => {
  const directory = temporaryDirectory(t, 'knowledge-capacity-')
  const store = new SqlTemplateStore(directory)
  for (let index = 0; index < count; index++) {
    const connectionId = `connection-${index}`
    const item = store.publishKnowledge({ sourceId: 'redis', connectionId, text: `GET key-${index}`, title: `Item ${index}` })
    store.proposeTidy({ sourceId: 'redis', connectionId, changes: [{ id: item.id, kind: 'update', title: `Approved ${index}` }] })
  }
  const before = readFileSync(store.path, 'utf8')
  const restored = new SqlTemplateStore(directory)
  assert.equal(restored.ensure().commands.length, count)
  assert.equal(restored.ensure().tidies.length, count)
  assert.equal(restored.getTidy('connection-0').changes.length, 1)
  assert.equal(readFileSync(store.path, 'utf8'), before)
})

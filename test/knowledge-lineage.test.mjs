import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { SqlTemplateStore } from '../src/host/sql-template-store.ts'
import { KnowledgeService } from '../src/host/knowledge-service.ts'
import { temporaryDirectory } from './helpers.mjs'

const seed = (store, dialect = 'mysql') => store.publish({ connectionId: 'a', dialect, action: 'create', title: 'Original', sql: 'SELECT id FROM orders' })
const publish = (store, item, action, sql = 'SELECT id, name FROM orders', extra = {}) => store.publish({ connectionId: 'a', dialect: item.dialect, targetId: item.id, expectedVersion: item.version, action, sql, ...extra })

test('save-from-query remains a connection-scoped creation path without a target ID', async t => {
  const store = new SqlTemplateStore(temporaryDirectory(t, 'query-publish-')), service = new KnowledgeService(store)
  const result = await service.dispatch('mysql', 'a', { action: 'template-publish', publishAction: 'fromSql', sql: 'SELECT id FROM orders', title: 'From query' })
  assert.ok(result.id)
  assert.equal(store.get(result.id).connectionId, 'a')
  assert.equal(store.get(result.id).features.parseOk, true)
  await store.whenIdle()
})

for (const dialect of ['mysql', 'oracle']) test(`${dialect} main and same-name variants advance independently, including tidy`, async t => {
  const directory = temporaryDirectory(t, 'lineages-'), store = new SqlTemplateStore(directory)
  const first = await seed(store, dialect); await store.whenIdle()
  const main = await publish(store, first, 'newVersion')
  const branch = await publish(store, main, 'variant', 'SELECT id, status FROM orders')
  assert.equal(main.familyId, branch.familyId)
  assert.notEqual(main.lineageId, branch.lineageId)
  const next = await publish(store, branch, 'newVersion', 'SELECT id, status, name FROM orders')
  assert.equal(next.version, 2)
  assert.equal(next.lineageId, branch.lineageId)
  const batch = store.proposeTidy({ connectionId: 'a', sourceId: dialect, changes: [{ id: main.id, kind: 'update', sql: 'SELECT id, name, price FROM orders', title: 'Main tidy' }] })
  assert.equal((await store.applyTidy('a', batch.id)).applied.length, 1)
  const visible = store.search('', dialect, 'a')
  assert.equal(visible.length, 2)
  assert.deepEqual(visible.map(x => x.version).sort(), [2, 3])
  await assert.rejects(publish(store, branch, 'newVersion'), /已被其他人更新/)
  await store.whenIdle()
  assert.deepEqual(new SqlTemplateStore(directory).search('', dialect, 'a').map(x => x.id).sort(), visible.map(x => x.id).sort())
})

for (const action of ['newVersion', 'variant', 'mergeMeta', 'useExisting']) test(`${action} refuses foreign connection and dialect at provider and store without writes`, async t => {
  const store = new SqlTemplateStore(temporaryDirectory(t, 'publish-scope-')), service = new KnowledgeService(store)
  const item = await seed(store); await store.whenIdle()
  const before = readFileSync(store.path, 'utf8')
  for (const [connectionId, dialect] of [['b', 'mysql'], ['a', 'oracle']]) {
    const input = { targetId: item.id, expectedVersion: 1, sql: 'SELECT id FROM orders', title: 'Foreign', connectionId, dialect }
    await assert.rejects(async () => service.dispatch(dialect, connectionId, { ...input, action: 'template-publish', publishAction: action }), /不属于|不匹配/)
    await assert.rejects(store.publish({ ...input, action }), /不属于|不匹配/)
    assert.equal(readFileSync(store.path, 'utf8'), before)
  }
})

test('touching an old revision does not replace the newest visible revision', async t => {
  const store = new SqlTemplateStore(temporaryDirectory(t, 'latest-lineage-'))
  const first = await seed(store); await store.whenIdle()
  const next = await publish(store, first, 'newVersion')
  // Usage timestamps are mutable and cannot define ancestry.
  store.ensure().templates.find(x => x.id === first.id).updatedAt = '2999-01-01T00:00:00.000Z'
  assert.equal(store.search('', 'mysql', 'a')[0].id, next.id)
})

test('API create receipt includes its own enrichment and is a usable next-save snapshot', async t => {
  const store = new SqlTemplateStore(temporaryDirectory(t, 'create-receipt-'))
  const first = await store.dispatch({ action: 'template-publish', publishAction: 'create', connectionId: 'a', dialect: 'mysql', title: 'Created', sql: 'SELECT id FROM orders' })
  assert.equal(first.features.parseOk, true)
  assert.match(first.summary, /orders/)
  const next = await store.dispatch({ action: 'template-publish', publishAction: 'newVersion', connectionId: 'a', dialect: 'mysql', targetId: first.id, expectedVersion: first.version,
    expectedSnapshot: { text: first.originalSql, title: first.title, summary: first.summary, tags: first.tags }, title: 'Next', sql: first.originalSql })
  assert.equal(next.version, 2)
})

test('exact create cannot merge metadata into an obsolete revision', async t => {
  const store = new SqlTemplateStore(temporaryDirectory(t, 'exact-head-'))
  const first = await seed(store); await store.whenIdle()
  const next = await publish(store, first, 'newVersion')
  const copy = await store.publish({ action: 'create', connectionId: 'a', dialect: 'mysql', sql: first.originalSql, title: 'New copy' })
  assert.notEqual(copy.id, first.id)
  assert.notEqual(copy.familyId, first.familyId)
  assert.equal(store.get(first.id).title, 'Original')
  assert.deepEqual(store.search('', 'mysql', 'a').map(x => x.id).sort(), [next.id, copy.id].sort())
  await store.whenIdle()
})

test('enrichment cannot acknowledge a concurrent author as the original save receipt', async t => {
  const store = new SqlTemplateStore(temporaryDirectory(t, 'enrich-concurrency-'))
  const pending = store.dispatch({ action: 'template-publish', publishAction: 'create', connectionId: 'a', dialect: 'mysql', title: 'First author', sql: 'SELECT id FROM orders' })
  const initial = store.ensure().templates[0]
  await publish(store, initial, 'mergeMeta', initial.originalSql, { title: 'External author', summary: 'External summary' })
  const receipt = await pending
  await store.whenIdle()
  assert.equal(receipt.title, 'First author')
  assert.equal(store.get(initial.id).title, 'External author')
  assert.equal(store.get(initial.id).summary, 'External summary')
  await assert.rejects(publish(store, receipt, 'newVersion', receipt.originalSql, { expectedSnapshot: { text: receipt.originalSql, title: receipt.title, summary: receipt.summary, tags: receipt.tags } }), /已被其他人更新/)
})

test('similarity publish carries the inspected target snapshot across metadata-only approval', async t => {
  const store = new SqlTemplateStore(temporaryDirectory(t, 'similar-snapshot-'))
  const item = await seed(store); await store.whenIdle()
  const preview = await store.preview('SELECT id, price FROM orders WHERE status = :status', 'mysql', 'a')
  const hit = preview.similar.find(x => x.id === item.id)
  assert.equal(hit.expectedSnapshot.title, 'Original')
  const batch = store.proposeTidy({ sourceId: 'mysql', connectionId: 'a', changes: [{ id: item.id, kind: 'update', title: 'Approved metadata' }] })
  await store.applyTidy('a', batch.id)
  assert.equal(store.get(item.id).version, hit.version)
  for (const action of ['newVersion', 'variant', 'mergeMeta']) await assert.rejects(publish(store, item, action, 'SELECT id, price FROM orders', { expectedSnapshot: hit.expectedSnapshot }), /已被其他人更新/)
  assert.equal(store.get(item.id).title, 'Approved metadata')
})

test('main and variant concurrent updates each allow exactly one successor', async t => {
  const store = new SqlTemplateStore(temporaryDirectory(t, 'branch-concurrency-'))
  const main = await seed(store); await store.whenIdle()
  const branch = await publish(store, main, 'variant')
  const results = await Promise.allSettled([main, main, branch, branch].map((item, index) => publish(store, item, 'newVersion', `SELECT id, column_${index} FROM orders`)))
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 2)
  assert.equal(results.filter(x => x.status === 'rejected').length, 2)
  assert.deepEqual(store.search('', 'mysql', 'a').map(x => x.version), [2, 2])
})

test('target archived while parsing is rejected on the latest commit snapshot', async t => {
  const store = new SqlTemplateStore(temporaryDirectory(t, 'parse-ownership-'))
  const item = await seed(store); await store.whenIdle()
  const viewed = store.get(item.id)
  const pending = publish(store, item, 'newVersion')
  store.archive(item.id, item.version, viewed.archiveGuard)
  const before = readFileSync(store.path, 'utf8')
  await assert.rejects(pending, /归档/)
  assert.equal(readFileSync(store.path, 'utf8'), before)
})

test('unscoped legacy targets are never claimed by connection-bound publish', async t => {
  const store = new SqlTemplateStore(temporaryDirectory(t, 'unscoped-target-'))
  const item = await store.publish({ action: 'create', dialect: 'mysql', sql: 'SELECT id FROM orders' })
  await store.whenIdle()
  const before = readFileSync(store.path, 'utf8')
  for (const action of ['newVersion', 'variant', 'mergeMeta', 'useExisting']) await assert.rejects(publish(store, item, action), /不属于/)
  assert.equal(readFileSync(store.path, 'utf8'), before)
})

test('conflicting migration backup blocks upgrade and preserves the original file', async t => {
  const directory = temporaryDirectory(t, 'backup-collision-'), store = new SqlTemplateStore(directory)
  await seed(store); await store.whenIdle()
  const old = JSON.parse(readFileSync(store.path, 'utf8')); old.version = 2
  old.templates.forEach(item => { delete item.lineageId })
  const bytes = JSON.stringify(old); writeFileSync(store.path, bytes)
  writeFileSync(`${store.path}.v2.bak`, 'other original file')
  const restored = new SqlTemplateStore(directory)
  assert.equal(restored.ensure().templates.length, 1)
  assert.throws(() => restored.publishKnowledge({ sourceId: 'redis', connectionId: 'a', text: 'GET copy' }), /备份与原文件不一致/)
  assert.equal(readFileSync(store.path, 'utf8'), bytes)
  assert.equal(restored.ensure().commands.length, 0)
})

for (const ambiguous of [false, true]) test(`legacy migration preserves ${ambiguous ? 'ambiguous' : 'unique'} histories and backs up before first write`, async t => {
  const directory = temporaryDirectory(t, 'legacy-lineage-'), original = new SqlTemplateStore(directory)
  const first = await seed(original); await original.whenIdle()
  const second = await publish(original, first, 'newVersion')
  const variant = await publish(original, second, 'variant', 'SELECT id, status FROM orders')
  const data = JSON.parse(readFileSync(original.path, 'utf8'))
  data.version = 2
  for (const row of data.templates) { delete row.lineageId; delete row.lineageAmbiguous }
  if (ambiguous) data.templates.push({ ...data.templates[1], id: 'ambiguous-v2' })
  const bytes = JSON.stringify(data); writeFileSync(original.path, bytes)
  const restored = new SqlTemplateStore(directory)
  assert.equal(restored.ensure().templates.length, data.templates.length)
  assert.equal(readFileSync(restored.path, 'utf8'), bytes)
  if (ambiguous) {
    for (const item of restored.ensure().templates) await assert.rejects(publish(restored, item, 'newVersion'), /历史版本关系/)
    // Saving a copy remains available; exact matching must not modify a frozen record.
    const copy = await restored.publish({ action: 'create', connectionId: 'a', dialect: 'mysql', sql: first.originalSql, title: 'Recovered copy' })
    assert.notEqual(copy.id, first.id)
  } else {
    const old = restored.get(variant.id)
    assert.equal(old.lineageId, variant.id)
    assert.equal(restored.get(second.id).lineageId, first.id)
    await publish(restored, old, 'newVersion', 'SELECT id, status, name FROM orders')
  }
  await restored.whenIdle()
  assert.ok(existsSync(`${restored.path}.v2.bak`))
  assert.equal(readFileSync(`${restored.path}.v2.bak`, 'utf8'), bytes)
  const disk = JSON.parse(readFileSync(restored.path, 'utf8'))
  assert.equal(disk.version, 3)
  assert.ok(new SqlTemplateStore(directory).ensure().templates.every(x => x.lineageId))
})

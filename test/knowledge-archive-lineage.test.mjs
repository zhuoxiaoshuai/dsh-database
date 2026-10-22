import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { SqlTemplateStore } from '../src/host/sql-template-store.ts'
import { temporaryDirectory } from './helpers.mjs'

for (const dialect of ['mysql', 'oracle']) for (const mode of ['publish', 'tidy']) test(`${dialect} archive closes the complete lineage before ${mode}`, async t => {
  const store = new SqlTemplateStore(temporaryDirectory(t, 'archive-lineage-'))
  const base = { connectionId: 'a', dialect }
  const first = await store.dispatch({ ...base, action: 'template-publish', publishAction: 'create', sql: 'SELECT id FROM orders' })
  const next = await store.publish({ ...base, action: 'newVersion', targetId: first.id, expectedVersion: 1, sql: 'SELECT id, name FROM orders' })
  const variant = await store.publish({ ...base, action: 'variant', targetId: next.id, expectedVersion: 2, sql: 'SELECT id, status FROM orders' })
  const batch = store.proposeTidy({ sourceId: dialect, connectionId: 'a', changes: [{ id: next.id, kind: 'update', sql: 'SELECT id, price FROM orders' }] })
  const archived = await store.dispatch({ ...base, action: 'template-archive', id: next.id, expectedVersion: 2, archiveGuard: store.get(next.id).archiveGuard })
  assert.deepEqual(new Set(archived.archived), new Set([first.id, next.id]))
  assert.deepEqual(store.search('', dialect, 'a').map(x => x.id), [variant.id])
  const before = readFileSync(store.path, 'utf8')
  if (mode === 'publish') for (const action of ['newVersion', 'variant', 'mergeMeta', 'useExisting']) {
    await assert.rejects(store.publish({ ...base, action, targetId: first.id, expectedVersion: 1, sql: 'SELECT id, price FROM orders' }), /更新|归档/)
  } else assert.equal((await store.applyTidy('a', batch.id)).failed.length, 1)
  assert.equal(readFileSync(store.path, 'utf8'), before)
  assert.equal(store.ensure().templates.length, 3)
  assert.deepEqual(new SqlTemplateStore(store.path.replace(/[\\/]knowledge.json$/, '')).search('', dialect, 'a').map(x => x.id), [variant.id])
})

test('archive rejects stale heads, missing versions and foreign targets without writes', async t => {
  const store = new SqlTemplateStore(temporaryDirectory(t, 'archive-cas-'))
  const first = await store.dispatch({ action: 'template-publish', publishAction: 'create', connectionId: 'a', dialect: 'mysql', sql: 'SELECT id FROM orders' })
  const next = await store.publish({ action: 'newVersion', connectionId: 'a', dialect: 'mysql', targetId: first.id, expectedVersion: 1, sql: 'SELECT id, name FROM orders' })
  const before = readFileSync(store.path, 'utf8')
  for (const body of [{ id: first.id, archiveGuard: first.archiveGuard }, { id: next.id },
    { id: next.id, archiveGuard: store.get(next.id).archiveGuard, connectionId: 'b' }, { id: next.id, archiveGuard: store.get(next.id).archiveGuard, dialect: 'oracle' }]) {
    await assert.rejects(store.dispatch({ action: 'template-archive', connectionId: 'a', dialect: 'mysql', ...body }))
    assert.equal(readFileSync(store.path, 'utf8'), before)
  }
})

test('existing partial archives stay closed and duplicate history stays readable but not writable', async t => {
  const root = temporaryDirectory(t, 'archive-legacy-'), store = new SqlTemplateStore(root)
  const first = await store.dispatch({ action: 'template-publish', publishAction: 'create', connectionId: 'a', dialect: 'mysql', sql: 'SELECT id FROM orders' })
  const next = await store.publish({ action: 'newVersion', connectionId: 'a', dialect: 'mysql', targetId: first.id, expectedVersion: 1, sql: 'SELECT id, name FROM orders' })
  const file = JSON.parse(readFileSync(store.path, 'utf8'))
  file.templates.find(x => x.id === next.id).archived = true
  writeFileSync(store.path, JSON.stringify(file))
  const closed = new SqlTemplateStore(root)
  assert.deepEqual(closed.search('', 'mysql', 'a'), [])
  await assert.rejects(closed.publish({ action: 'newVersion', connectionId: 'a', dialect: 'mysql', targetId: first.id, expectedVersion: 1, sql: first.originalSql }))
  file.templates.push({ ...file.templates[1], id: 'duplicate-version', archived: false })
  writeFileSync(store.path, JSON.stringify(file))
  const ambiguous = new SqlTemplateStore(root)
  assert.equal(ambiguous.ensure().templates.length, 3)
  assert.ok(ambiguous.search('', 'mysql', 'a').every(x => x.lineageAmbiguous))
  await assert.rejects(ambiguous.publish({ action: 'newVersion', connectionId: 'a', dialect: 'mysql', targetId: 'duplicate-version', expectedVersion: 2, sql: first.originalSql }), /历史版本/)
  assert.equal(JSON.parse(readFileSync(store.path, 'utf8')).templates.length, 3)
})

for (const mode of ['duplicates', 'tidy']) test(`${mode} archives complete duplicate lineage while preserving its sibling`, async t => {
  const store = new SqlTemplateStore(temporaryDirectory(t, 'duplicate-lineage-'))
  const base = { connectionId: 'a', dialect: 'mysql', sql: 'SELECT id FROM orders' }
  const first = await store.dispatch({ ...base, action: 'template-publish', publishAction: 'create' })
  const head = await store.publish({ ...base, action: 'newVersion', targetId: first.id, expectedVersion: 1 })
  const sibling = await store.publish({ ...base, action: 'variant', targetId: head.id, expectedVersion: 2 })
  if (mode === 'duplicates') store.archiveDuplicates('a', sibling.id, [head.id], 'mysql', [sibling, head].map(item => ({ id: item.id, archiveGuard: store.get(item.id).archiveGuard })))
  else {
    const batch = store.proposeTidy({ sourceId: 'mysql', connectionId: 'a', changes: [{ id: head.id, kind: 'archive' }] })
    assert.equal((await store.applyTidy('a', batch.id)).applied.length, 1)
  }
  assert.deepEqual(store.search('', 'mysql', 'a').map(x => x.id), [sibling.id])
  assert.ok(store.ensure().templates.filter(x => x.lineageId === first.lineageId).every(x => x.archived))
})

test('duplicate archive validates all targets before a durable commit and preserves the keep chain', async t => {
  const store = new SqlTemplateStore(temporaryDirectory(t, 'duplicate-atomic-'))
  const base = { connectionId: 'a', dialect: 'mysql', sql: 'SELECT id FROM orders' }
  const first = await store.dispatch({ ...base, action: 'template-publish', publishAction: 'create' })
  const head = await store.publish({ ...base, action: 'newVersion', targetId: first.id, expectedVersion: 1 })
  const sibling = await store.publish({ ...base, action: 'variant', targetId: head.id, expectedVersion: 2 })
  const before = readFileSync(store.path, 'utf8')
  assert.throws(() => store.archiveDuplicates('a', sibling.id, [head.id, 'missing'], 'mysql',
    [sibling, head, { id: 'missing', archiveGuard: head.archiveGuard }].map(item => ({ id: item.id, archiveGuard: item.archiveGuard }))))
  assert.throws(() => store.archiveDuplicates('a', head.id, [first.id], 'mysql', [head, first].map(item => ({ id: item.id, archiveGuard: item.archiveGuard }))))
  assert.equal(readFileSync(store.path, 'utf8'), before)
  assert.equal(store.get(head.id).archived, false)
})

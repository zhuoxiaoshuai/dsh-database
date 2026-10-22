import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { SqlTemplateStore } from '../src/host/sql-template-store.ts'
import { temporaryDirectory } from './helpers.mjs'

const CONN = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const SQL = 'SELECT id FROM orders WHERE id = 1'

function open(t) {
  return new SqlTemplateStore(temporaryDirectory(t, 'knowledge-tidy-'))
}

test('propose stores a pending batch and leaves published SQL unchanged', async t => {
  const store = open(t)
  const saved = await store.publish({ sql: SQL, dialect: 'mysql', connectionId: CONN, title: '旧标题', action: 'create' })
  const commented = store.proposeTidy({
    connectionId: CONN, sourceId: 'mysql',
    changes: [{ id: saved.id, kind: 'update', title: '查订单', summary: '按主键', sql: `-- 按主键\n${SQL}` }],
  })
  assert.equal(commented.changes[0].risk, 'same')
  assert.equal(store.get(saved.id)?.originalSql, SQL)
  assert.equal(store.get(saved.id)?.title, '旧标题')
  assert.equal(store.search('', 'mysql', CONN)[0].originalSql, SQL)
  const changed = store.proposeTidy({
    connectionId: CONN, sourceId: 'mysql',
    changes: [{ id: saved.id, kind: 'update', title: '改条件', sql: 'SELECT id FROM orders WHERE id = 2' }],
  })
  assert.equal(changed.changes.length, 1)
  assert.equal(changed.changes[0].risk, 'executable-changed')
  assert.equal(store.getTidy(CONN)?.changes[0].risk, 'executable-changed')
  const listed = await store.dispatch({ action: 'template-tidy-get', connectionId: CONN })
  assert.equal(listed.tidy.changes[0].after.text.includes('id = 2'), true)
  await store.rejectTidy(CONN, store.getTidy(CONN).id)
  assert.equal(store.getTidy(CONN), undefined)
  assert.equal(store.get(saved.id)?.originalSql, SQL)
  assert.throws(() => store.proposeTidy({
    connectionId: CONN, sourceId: 'mysql',
    changes: Array.from({ length: 31 }, (_, index) => ({ id: String(index), kind: 'update' })),
  }), /30/)
})

test('approval publishes the new SQL and a version conflict fails only that row', async t => {
  const store = open(t)
  const first = await store.publish({ sql: SQL, dialect: 'mysql', connectionId: CONN, title: '第一', action: 'create' })
  const second = await store.publish({ sql: 'SELECT id FROM customers WHERE id = 1', dialect: 'mysql', connectionId: CONN, title: '第二', action: 'create' })
  await store.whenIdle()
  store.proposeTidy({
    connectionId: CONN, sourceId: 'mysql',
    changes: [
      { id: first.id, kind: 'update', title: '提案一', sql: `-- 提案\n${SQL}` },
      { id: second.id, kind: 'update', title: '提案二', sql: '-- 客户\nSELECT id FROM customers WHERE id = 1' },
    ],
  })
  await store.publish({
    sql: `${SQL} /* 人手 */`, dialect: 'mysql', connectionId: CONN, title: '人手',
    action: 'newVersion', targetId: first.id, expectedVersion: first.version,
  })
  const result = await store.applyTidy(CONN, store.getTidy(CONN).id)
  assert.deepEqual(result.applied, [second.id])
  assert.equal(result.failed.length, 1)
  assert.match(result.failed[0].message, /已被其他人更新/)
  assert.equal(result.remaining, 1)
  const rows = store.search('', 'mysql', CONN)
  assert.equal(rows.find(item => item.title === '人手')?.originalSql.includes('人手'), true)
  assert.equal(rows.find(item => item.title === '提案二')?.originalSql.includes('-- 客户'), true)
  assert.equal(store.libraryCount(CONN, 'mysql'), 2)
  await store.rejectTidy(CONN, store.getTidy(CONN).id, [first.id])
  assert.equal(store.getTidy(CONN), undefined)
  assert.equal(store.search('', 'mysql', CONN).some(item => item.title === '人手'), true)
})

test('a command tidy can retitle without changing the command and still rejects credentials and writes', async t => {
  const store = open(t)
  const redis = store.publishKnowledge({ sourceId: 'redis', connectionId: CONN, text: 'GET customer:1', title: '旧命令' })
  const batch = store.proposeTidy({ connectionId: CONN, sourceId: 'redis', changes: [{ id: redis.id, kind: 'update', title: '查看客户' }] })
  assert.equal(batch.changes[0].risk, 'same')
  assert.equal(batch.changes[0].after.text, 'GET customer:1')
  assert.equal(store.searchKnowledge('redis', CONN)[0].title, '旧命令')
  await store.applyTidy(CONN, store.getTidy(CONN).id)
  assert.equal(store.searchKnowledge('redis', CONN)[0].title, '查看客户')
  assert.equal(store.searchKnowledge('redis', CONN)[0].text, 'GET customer:1')
  const current = store.searchKnowledge('redis', CONN)[0]
  assert.throws(() => store.proposeTidy({ connectionId: CONN, sourceId: 'redis', changes: [{ id: current.id, kind: 'update', sql: 'AUTH user password' }] }), /凭据/)
  assert.equal(store.getTidy(CONN), undefined)
  const kafka = store.publishKnowledge({ sourceId: 'kafka', connectionId: CONN, text: 'PEEK "orders" PARTITION 0 FROM BEGINNING', title: '查看' })
  assert.throws(() => store.proposeTidy({
    connectionId: CONN, sourceId: 'kafka',
    changes: [{ id: kafka.id, kind: 'update', sql: 'PRODUCE {"topic":"orders","value":"hello"}' }],
  }), /写操作/)
  assert.equal(store.getTidy(CONN), undefined)
  assert.throws(() => store.proposeTidy({ connectionId: OTHER, sourceId: 'redis', changes: [{ id: current.id, kind: 'update', title: '跨连接' }] }), /不属于此连接/)
  assert.throws(() => store.proposeTidy({ connectionId: CONN, sourceId: 'nacos', changes: [{ id: current.id, kind: 'update' }] }), /没有经验库/)
})

test('a version 2 knowledge file without tidies still opens', async t => {
  const store = open(t)
  const saved = await store.publish({ sql: SQL, dialect: 'mysql', connectionId: CONN, title: '旧', action: 'create' })
  const raw = JSON.parse(readFileSync(store.path, 'utf8'))
  delete raw.tidies
  writeFileSync(store.path, JSON.stringify(raw))
  const reopened = new SqlTemplateStore(dirname(store.path))
  assert.equal(reopened.get(saved.id)?.title, '旧')
  assert.equal(reopened.libraryCount(CONN, 'mysql'), 1)
  assert.equal(reopened.getTidy(CONN), undefined)
  assert.equal(reopened.libraryCount(CONN, 'nacos'), 0)
})


test('stale or missing approval identity cannot apply or reject a replacement proposal through either provider', async t => {
  const store = open(t)
  const item = store.publishKnowledge({ sourceId: 'redis', connectionId: CONN, text: 'GET customer:1', title: 'Original' })
  const viewed = store.proposeTidy({ connectionId: CONN, sourceId: 'redis', changes: [{ id: item.id, kind: 'update', title: 'Reviewed' }] })
  const replacement = store.proposeTidy({ connectionId: CONN, sourceId: 'redis', changes: [{ id: item.id, kind: 'update', sql: 'DEL customer:1' }] })
  const { createKnowledgeProvider } = await import('../src/host/knowledge-dispatch.ts')
  const provider = createKnowledgeProvider('redis')
  for (const action of ['knowledge-tidy-apply', 'knowledge-tidy-reject']) {
    if (action.endsWith('apply')) await assert.rejects(provider.dispatch(store, CONN, { action, batchId: viewed.id }), /提案已变化/)
    else assert.throws(() => provider.dispatch(store, CONN, { action, batchId: viewed.id }), /提案已变化/)
  }
  await assert.rejects(store.dispatch({ action: 'template-tidy-apply', connectionId: CONN, batchId: viewed.id }), /提案已变化/)
  await assert.rejects(store.dispatch({ action: 'template-tidy-apply', connectionId: CONN }), /提案已变化/)
  assert.equal(store.getKnowledge('redis', item.id, CONN).text, 'GET customer:1')
  assert.equal(store.getTidy(CONN).id, replacement.id)
})

for (const sourceId of ['redis', 'mysql']) {
  test(`${sourceId} rejects changed archive targets without a partial update`, async t => {
    const store = open(t)
    const save = async (text, title) => sourceId === 'redis'
      ? store.publishKnowledge({ sourceId, connectionId: CONN, text, title })
      : store.publish({ sql: text, title, connectionId: CONN, dialect: sourceId, action: 'create' })
    const a = await save(sourceId === 'redis' ? 'GET a' : SQL, 'A')
    const b = await save(sourceId === 'redis' ? 'GET b' : 'SELECT id FROM customers', 'B')
    await store.whenIdle()
    const batch = store.proposeTidy({ connectionId: CONN, sourceId, changes: [{ id: a.id, kind: 'update', title: 'Merged', archiveIds: [b.id] }] })
    assert.equal(batch.changes[0].archiveTargets[0].before.title, 'B')
    assert.equal(batch.changes[0].archiveTargets[0].before.text, sourceId === 'redis' ? 'GET b' : 'SELECT id FROM customers')
    if (sourceId === 'redis') store.publishKnowledge({ sourceId, connectionId: CONN, id: b.id, text: 'GET changed', title: 'Changed', expectedVersion: b.version })
    else await store.publish({ sql: 'SELECT name FROM customers', dialect: sourceId, connectionId: CONN, title: 'Changed', targetId: b.id, action: 'newVersion', expectedVersion: b.version })
    const before = readFileSync(store.path, 'utf8')
    const result = await store.applyTidy(CONN, batch.id)
    assert.equal(result.failed.length, 1)
    assert.equal(readFileSync(store.path, 'utf8'), before)
    assert.equal(sourceId === 'redis' ? store.getKnowledge(sourceId, a.id, CONN).title : store.get(a.id).title, 'A')
    assert.equal(store.getTidy(CONN).changes.length, 1)
  })

  test(`${sourceId} commits updates, archives and approval removal together and can reopen`, async t => {
    const store = open(t)
    const a = sourceId === 'redis' ? store.publishKnowledge({ sourceId, connectionId: CONN, text: 'GET a', title: 'A' })
      : await store.publish({ sql: SQL, dialect: sourceId, connectionId: CONN, title: 'A', action: 'create' })
    const b = sourceId === 'redis' ? store.publishKnowledge({ sourceId, connectionId: CONN, text: 'GET b', title: 'B' })
      : await store.publish({ sql: 'SELECT id FROM customers', dialect: sourceId, connectionId: CONN, title: 'B', action: 'create' })
    await store.whenIdle()
    const batch = store.proposeTidy({ connectionId: CONN, sourceId, changes: [{ id: a.id, kind: 'update', title: 'Merged', sql: sourceId === 'redis' ? 'GET merged' : `-- merged\n${SQL}`, archiveIds: [b.id] }] })
    const reopened = new SqlTemplateStore(dirname(store.path))
    assert.deepEqual(reopened.getTidy(CONN), batch)
    const result = await reopened.applyTidy(CONN, batch.id)
    assert.deepEqual(result.applied, [a.id])
    const final = new SqlTemplateStore(dirname(store.path))
    assert.equal(final.getTidy(CONN), undefined)
    assert.equal(sourceId === 'redis' ? final.getKnowledge(sourceId, b.id, CONN) : final.get(b.id), undefined)
    assert.equal(sourceId === 'redis' ? final.searchKnowledge(sourceId, CONN)[0].title : final.search('', sourceId, CONN)[0].title, 'Merged')
  })

  test(`${sourceId} failed persistence preserves content, archives and pending approval for retry`, async t => {
    const store = open(t)
    const a = sourceId === 'redis' ? store.publishKnowledge({ sourceId, connectionId: CONN, text: 'GET a', title: 'A' })
      : await store.publish({ sql: SQL, dialect: sourceId, connectionId: CONN, title: 'A', action: 'create' })
    const b = sourceId === 'redis' ? store.publishKnowledge({ sourceId, connectionId: CONN, text: 'GET b', title: 'B' })
      : await store.publish({ sql: 'SELECT id FROM customers', dialect: sourceId, connectionId: CONN, title: 'B', action: 'create' })
    await store.whenIdle()
    const batch = store.proposeTidy({ connectionId: CONN, sourceId, changes: [{ id: a.id, kind: 'update', title: 'Merged', archiveIds: [b.id] }] })
    const original = readFileSync(store.path, 'utf8')
    const backup = store.path + '.backup'
    renameSync(store.path, backup)
    mkdirSync(store.path)
    try {
      const result = await store.applyTidy(CONN, batch.id)
      assert.equal(result.failed.length, 1)
      assert.deepEqual(result.applied, [])
      assert.deepEqual(store.getTidy(CONN), batch)
      assert.equal(sourceId === 'redis' ? store.getKnowledge(sourceId, a.id, CONN).title : store.get(a.id).title, 'A')
      assert.ok(sourceId === 'redis' ? store.getKnowledge(sourceId, b.id, CONN) : store.get(b.id))
      assert.equal(readFileSync(backup, 'utf8'), original)
    } finally {
      rmdirSync(store.path)
      renameSync(backup, store.path)
    }
    const retry = await store.applyTidy(CONN, batch.id)
    assert.deepEqual(retry.applied, [a.id])
    assert.equal(store.getTidy(CONN), undefined)
  })
}

test('SQL approval rechecks a replaced proposal after asynchronous parsing', async t => {
  const store = open(t)
  const item = await store.publish({ sql: SQL, dialect: 'mysql', connectionId: CONN, title: 'Original', action: 'create' })
  await store.whenIdle()
  const batch = store.proposeTidy({ connectionId: CONN, sourceId: 'mysql', changes: [{ id: item.id, kind: 'update', sql: `-- reviewed\n${SQL}` }] })
  const applying = store.applyTidy(CONN, batch.id)
  const replacement = store.proposeTidy({ connectionId: CONN, sourceId: 'mysql', changes: [{ id: item.id, kind: 'update', title: 'Replacement' }] })
  const result = await applying
  assert.equal(result.failed.length, 1)
  assert.equal(store.get(item.id).title, 'Original')
  assert.equal(store.getTidy(CONN).id, replacement.id)
})

test('legacy pending proposals are discarded without losing published experience', async t => {
  const store = open(t)
  const item = store.publishKnowledge({ sourceId: 'redis', connectionId: CONN, text: 'GET a', title: 'A' })
  store.proposeTidy({ connectionId: CONN, sourceId: 'redis', changes: [{ id: item.id, kind: 'archive' }] })
  const raw = JSON.parse(readFileSync(store.path, 'utf8'))
  delete raw.tidies[0].id
  writeFileSync(store.path, JSON.stringify(raw))
  const reopened = new SqlTemplateStore(dirname(store.path))
  assert.equal(reopened.getTidy(CONN), undefined)
  assert.equal(reopened.getKnowledge('redis', item.id, CONN).title, 'A')
})

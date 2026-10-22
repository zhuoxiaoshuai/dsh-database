import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SqlTemplateStore } from '../src/host/sql-template-store.ts'
import { KnowledgeService } from '../src/host/knowledge-service.ts'
import { temporaryDirectory } from './helpers.mjs'

for (const sourceId of ['mysql', 'oracle', 'redis', 'kafka']) {
  const sql = sourceId === 'mysql' || sourceId === 'oracle'
  test(`${sourceId} archive guards protect full content and the whole duplicate decision`, async t => {
    const store = new SqlTemplateStore(temporaryDirectory(t, 'archive-guard-')), service = new KnowledgeService(store)
    const text = sql ? 'SELECT id FROM orders' : sourceId === 'redis' ? 'GET keep' : 'TOPICS'
    const keep = sql
      ? await store.dispatch({ action: 'template-publish', publishAction: 'create', connectionId: 'a', dialect: sourceId, sql: text, title: 'Keep' })
      : store.publishKnowledge({ sourceId, connectionId: 'a', text, title: 'Keep' })
    let target
    if (sql) target = await store.publish({ action: 'variant', connectionId: 'a', dialect: sourceId, targetId: keep.id, expectedVersion: keep.version, sql: text, title: 'Target' })
    else {
      const other = store.publishKnowledge({ sourceId, connectionId: 'a', text: sourceId === 'redis' ? 'GET other' : 'GROUPS' })
      target = store.publishKnowledge({ sourceId, connectionId: 'a', id: other.id, expectedVersion: other.version, text, title: 'Target' })
    }
    await store.whenIdle()
    const foreign = sql
      ? await store.dispatch({ action: 'template-publish', publishAction: 'create', connectionId: 'foreign', dialect: sourceId, sql: text, title: 'Foreign' })
      : store.publishKnowledge({ sourceId, connectionId: 'foreign', text, title: 'Foreign' })
    const groups = sql ? store.clusterPublished('a', sourceId) : store.clusterKnowledge(sourceId, 'a')
    const group = groups.find(group => group.members.some(item => item.id === target.id))
    assert.ok(group.members.every(item => item.archiveGuard?.expectedContentToken))
    const viewed = group.members.map(item => ({ id: item.id, archiveGuard: item.archiveGuard }))
    if (sql) await store.publish({ action: 'mergeMeta', connectionId: 'a', dialect: sourceId, targetId: keep.id, expectedVersion: keep.version, sql: text, title: 'Other author' })
    else store.publishKnowledge({ sourceId, connectionId: 'a', id: keep.id, expectedVersion: keep.version, text, title: 'Other author' })
    const prefix = sql ? 'template-' : 'knowledge-'
    const before = readFileSync(store.path, 'utf8')
    const dispatch = body => service.dispatch(sourceId, 'a', body)
    const foreignGuards = [keep, foreign].map(item => ({ id: item.id, archiveGuard: (sql ? store.get(item.id) : store.getKnowledge(sourceId, item.id, item.connectionId)).archiveGuard }))
    await assert.rejects(Promise.resolve().then(() => dispatch({ action: prefix + 'archive-duplicates', keepId: keep.id, ids: [foreign.id], guards: foreignGuards })))
    await assert.rejects(Promise.resolve().then(() => dispatch({ action: prefix + 'archive', id: foreign.id, archiveGuard: foreign.archiveGuard })))
    assert.equal(readFileSync(store.path, 'utf8'), before)
    for (const guards of [undefined, viewed, [...viewed, viewed[0]], viewed.filter(item => item.id !== keep.id)]) {
      await assert.rejects(Promise.resolve().then(() => dispatch({ action: prefix + 'archive-duplicates', keepId: keep.id, ids: [target.id], guards })))
      assert.equal(readFileSync(store.path, 'utf8'), before)
    }
    await assert.rejects(Promise.resolve().then(() => dispatch({ action: prefix + 'archive', id: target.id })))
    assert.equal(readFileSync(store.path, 'utf8'), before)
    const latest = sql ? store.clusterPublished('a', sourceId) : store.clusterKnowledge(sourceId, 'a')
    const guards = latest.flatMap(group => group.members).filter(item => [keep.id, target.id].includes(item.id)).map(item => ({ id: item.id, archiveGuard: item.archiveGuard }))
    await dispatch({ action: prefix + 'archive-duplicates', keepId: keep.id, ids: [target.id], guards })
    assert.equal(sql ? store.get(target.id) : store.getKnowledge(sourceId, target.id, 'a'), undefined)
    assert.ok(sql ? store.get(keep.id) : store.getKnowledge(sourceId, keep.id, 'a'))
    assert.equal(readFileSync(store.path, 'utf8').includes('expectedContentToken'), false, 'guards never change the persisted knowledge format')
  })
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { controlExecutionDocument, emptyExecutionDocument, sameStringMap, updateExecutionDocument, withExecutionDocumentContext } from '../src/shared/execution-document.ts'
import { matchesResultOwner, ownsDocumentResult, sameDocumentResultTarget } from '../src/shared/query-sync.ts'
import { catalogToolFailure } from '../src/host/sql-catalog-operation.ts'

test('document edits, takeover and return follow one revision lane', () => {
  const empty = emptyExecutionDocument('mysql')
  assert.deepEqual(empty, { sourceId: 'mysql', text: '', context: {}, revision: 1, controller: 'ai' })

  const published = updateExecutionDocument(empty, 'SELECT 1', 'ai', 1)
  assert.deepEqual(published, { sourceId: 'mysql', text: 'SELECT 1', context: {}, revision: 2, controller: 'ai', controllerReason: 'ai-publish' })

  // The same text under the same controller is a no-op that keeps the revision.
  assert.equal(updateExecutionDocument(published, 'SELECT 1', 'ai', 2), published)

  // A stale revision never writes.
  assert.throws(() => updateExecutionDocument(published, 'SELECT 2', 'ai', 1), /已变化/)

  // User takeover takes control and bumps the revision exactly once.
  const taken = updateExecutionDocument(published, 'SELECT 2', 'user', 2)
  assert.deepEqual(taken, { ...published, text: 'SELECT 2', revision: 3, controller: 'user', controllerReason: 'user-edit' })

  // AI cannot overwrite a user-controlled editor.
  assert.throws(() => updateExecutionDocument(taken, 'SELECT 3', 'ai', 3), /接管/)

  // System updates keep the controller and its reason.
  const system = updateExecutionDocument(taken, 'SELECT 4', 'system', 3)
  assert.deepEqual(system, { ...taken, text: 'SELECT 4', revision: 4 })

  // Returning to the AI hands control back exactly once.
  const returned = controlExecutionDocument(system, 'ai')
  assert.deepEqual(returned, { ...system, revision: 5, controller: 'ai', controllerReason: 'return-ai' })
  assert.equal(controlExecutionDocument(returned, 'ai'), returned)

  // Context patches are atomic and revision-guarded; an unchanged patch keeps the revision.
  const patched = withExecutionDocumentContext(returned, { schema: 'app' }, 5)
  assert.deepEqual(patched, { ...returned, context: { schema: 'app' }, revision: 6 })
  assert.equal(withExecutionDocumentContext(patched, { schema: 'app' }, 6), patched)
  assert.throws(() => withExecutionDocumentContext(patched, { schema: 'other' }, 5), /已变化/)
})

test('result adoption survives edits but never crosses a target or takeover boundary', () => {
  const document = { sourceId: 'mysql', text: 'SELECT 1', context: { schema: 'app' }, revision: 4, controller: 'ai' }
  const owner = { connectionId: 'c1', generation: 'g1', conversationId: 'conv', document }
  const identity = {
    conversationId: 'conv', connectionId: 'c1', generation: 'g1', sourceId: 'mysql', context: { schema: 'app' },
    queryRevision: 4, documentText: 'SELECT 1', executedSql: 'SELECT 1', initiator: 'ai',
  }
  const ownerTuple = {
    conversationId: 'conv', connectionId: 'c1', generation: 'g1', context: document.context,
    sql: document.text, queryRevision: document.revision, controller: document.controller,
  }

  assert.equal(matchesResultOwner(identity, ownerTuple), true)
  assert.equal(ownsDocumentResult(identity, owner), true)

  // An AI result never lands on a user-owned document; a user run does.
  assert.equal(matchesResultOwner({ ...identity, initiator: 'ai' }, { ...ownerTuple, controller: 'user' }), false)
  assert.equal(matchesResultOwner({ ...identity, initiator: 'user' }, { ...ownerTuple, controller: 'user' }), true)

  // Identity drift drops the result.
  for (const patch of [{ queryRevision: 3 }, { sql: 'SELECT 2' }, { context: { schema: 'other' } },
    { generation: 'g2' }, { connectionId: 'c2' }, { conversationId: 'other' }]) {
    assert.equal(matchesResultOwner({ ...identity }, { ...ownerTuple, ...patch }), false, JSON.stringify(patch))
  }

  // Unsaved documents own nothing.
  assert.equal(ownsDocumentResult(identity, { ...owner, unsaved: true }), false)
  assert.equal(ownsDocumentResult(identity, { ...owner, document: { ...document, text: 'SELECT 9' } }), false)

  // Displayed receipts survive an edit, but never a changed target.
  assert.equal(sameDocumentResultTarget(identity, { ...owner, document: { ...document, text: 'SELECT 9', revision: 9 } }), true)
  assert.equal(sameDocumentResultTarget(identity, { ...owner, document: { ...document, context: { schema: 'other' } } }), false)
  assert.equal(sameDocumentResultTarget(identity, { ...owner, generation: 'g2' }), false)
  // Takeover is an ownership rule, not a target change.
  assert.equal(sameDocumentResultTarget({ ...identity, initiator: 'ai' }, { ...owner, document: { ...document, controller: 'user' } }), true)
})

test('local tool failures share one classification ladder', () => {
  const lifecycle = (aborted, dispatched) => ({ aborted, dispatched })
  assert.deepEqual(catalogToolFailure(new Error('boom'), lifecycle(false, false)), { status: 'failed', message: 'boom' })
  assert.deepEqual(catalogToolFailure(new Error('boom'), lifecycle(true, false)), { status: 'cancelled', message: '已取消。' })
  assert.deepEqual(catalogToolFailure(new Error('boom'), lifecycle(true, true)), { status: 'unknown', message: '结果未知。' })
  assert.deepEqual(catalogToolFailure(new Error('用户取消了'), lifecycle(false, true)), { status: 'unknown', message: '结果未知。' })
  assert.deepEqual(catalogToolFailure(new Error('查询超过 5 秒，已超时'), lifecycle(false, true)), { status: 'failed', message: '查询超过 5 秒，已超时' })
  assert.deepEqual(catalogToolFailure(new Error('写入 timeout 了'), lifecycle(false, false)), { status: 'unknown', message: '写入 timeout 了', event: 'timeout' })
  assert.deepEqual(catalogToolFailure(new Error('连接已关闭'), lifecycle(false, true)), { status: 'unknown', message: '连接已关闭', event: 'disconnect' })
  assert.deepEqual(catalogToolFailure('boom', lifecycle(false, false)), { status: 'failed', message: '操作失败' })
})

test('document context comparison ignores key order but not shape', () => {
  assert.equal(sameStringMap({ schema: 'app', database: '1' }, { database: '1', schema: 'app' }), true)
  assert.equal(sameStringMap({}, {}), true)
  assert.equal(sameStringMap({ schema: 'app' }, { schema: 'app', database: '1' }), false)
  assert.equal(sameStringMap({ schema: 'app', database: '1' }, { schema: 'app' }), false)
  assert.equal(sameStringMap({ schema: 'app' }, { schema: 'other' }), false)
})

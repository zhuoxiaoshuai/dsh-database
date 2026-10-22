import test from 'node:test'
import assert from 'node:assert/strict'
import { KnowledgeExecutionScope, knowledgeCommandReceipt } from '../src/client/workspace/knowledge/execution-owner.ts'
import { DraftSessions, newDraft, editDraft, acceptDraft } from '../src/client/workspace/knowledge/draft-session.ts'

test('execution ownership survives edits, reverting fields and replacing selection bindings', () => {
  const sessions = new DraftSessions(), scope = new KnowledgeExecutionScope('mysql\0a\0g1\0app')
  const owner = { ...newDraft(), text: 'SELECT 1', title: 'Original' }
  sessions.set('__draft__', owner)
  const ticket = scope.begin(owner.token, owner.text, 'SELECT 1', 'app')
  sessions.update({ ...owner, executionPending: ticket })
  const edited = editDraft(editDraft(sessions.byToken(owner.token), { title: 'Changed' }), { title: 'Original' })
  sessions.update(edited)
  sessions.set('__draft__', { ...newDraft(), title: 'New' })
  assert.ok(scope.owns(ticket)); assert.equal(scope.begin(owner.token, 'x', 'x', 'app'), undefined)
  assert.equal(sessions.recoverable(Symbol())[0].token, owner.token)
  const before = sessions.byToken(owner.token)
  sessions.update({ ...before, result: 'receipt', executionPending: undefined })
  assert.equal(sessions.byToken(owner.token).revision, 2)
  assert.equal(sessions.get('__draft__').title, 'New'); assert.equal(sessions.byToken(owner.token).result, 'receipt')
  assert.ok(scope.finish(ticket)); assert.equal(scope.current, undefined)
})

test('a clean executing draft is retained on delete and remains recoverable after completion', () => {
  const sessions = new DraftSessions(), owner = { ...newDraft(), title: 'Clean', executionPending: {} }
  sessions.set('a', owner); sessions.delete('a')
  sessions.update({ ...sessions.byToken(owner.token), executionPending: undefined, result: 'done' })
  assert.equal(sessions.recoverable(Symbol())[0].result, 'done')
})

test('stop retains terminal ownership, whereas invalidation rejects A to B to A and stale cleanup', () => {
  const scope = new KnowledgeExecutionScope('A'), owner = Symbol()
  const first = scope.begin(owner, 'text', 'selected', 'A')
  scope.stop(); assert.ok(first.controller.signal.aborted); assert.ok(scope.owns(first))
  assert.equal(first.receiptController.signal.aborted, false, 'stopping must keep the terminal receipt channel open')
  scope.setIdentity('B'); scope.setIdentity('A')
  const next = scope.begin(owner, 'next', 'next', 'A')
  assert.equal(scope.owns(first), false); assert.equal(scope.finish(first), false); assert.equal(scope.current, next)
  assert.equal(first.receiptController.signal.aborted, true)
  scope.invalidate(); assert.ok(next.controller.signal.aborted); assert.equal(scope.finish(next), false)
})

test('execution pinning does not acknowledge or alter save baselines', () => {
  const sent = { ...newDraft(), title: 'Sent', text: 'GET key', base: { id: 'a', version: 1, snapshot: { text: 'GET key', title: 'Sent', summary: '', tags: [] } } }
  const pending = {}, current = { ...editDraft(sent, { title: 'Continued' }), executionPending: pending }
  const accepted = acceptDraft(current, sent, { title: 'Sent', text: 'GET key' }, { ...sent.base, version: 2 })
  assert.equal(accepted.title, 'Continued'); assert.equal(accepted.executionPending, pending); assert.equal(accepted.base.version, 2)
})

test('source terminal status and trusted partial payload survive, untrusted partials are rejected', () => {
  const partial = { kind: 'produce-batch', receipts: [{ index: 0, baseOffset: '9007199254740993' }], status: 'unknown' }
  const failure = Object.assign(new Error('unknown write'), { effect: 'unknown', executionId: 'e1', executionStatus: 'unknown', trustedReceipt: true, sourceResult: partial })
  const accepted = knowledgeCommandReceipt(failure, true)
  assert.equal(accepted.result, partial); assert.equal(accepted.status, 'unknown'); assert.equal(accepted.executionId, 'e1'); assert.equal(accepted.error, 'unknown write')
  assert.equal(knowledgeCommandReceipt({ ...failure, trustedReceipt: false }, true).result, undefined)
  assert.equal(knowledgeCommandReceipt({ executionStatus: 'failed', message: 'failed' }).status, 'failed')
  assert.equal(knowledgeCommandReceipt({ executionStatus: 'unknown', message: 'unknown' }).error, 'unknown')
  assert.equal(knowledgeCommandReceipt({ executionStatus: 'succeeded' }).error, '')
})

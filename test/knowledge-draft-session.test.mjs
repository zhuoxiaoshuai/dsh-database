import test from 'node:test'
import assert from 'node:assert/strict'
import { newDraft, editDraft, acceptDraft, DraftSessions } from '../src/client/workspace/knowledge/draft-session.ts'

const draft = title => ({ ...newDraft(), text: 'GET key', title, summary: '', tags: '' })
const base = { id: 'a', version: 2, snapshot: { text: 'GET key', title: 'Accepted', summary: '', tags: [] } }
test('field revision protects an edit changed back while accepting untouched normalized fields', () => {
  const sent = draft(' Original ')
  const current = editDraft(editDraft(sent, { title: 'Temporary' }), { title: sent.title })
  const next = acceptDraft(current, sent, { text: 'GET key', title: 'Original', summary: 'Normalized', tags: '' }, base)
  assert.equal(next.title, ' Original '); assert.equal(next.summary, 'Normalized'); assert.equal(next.base.version, 2); assert.ok(next.dirty)
})
test('receipts never replace another draft bound to their target entry', () => {
  const sessions = new DraftSessions(), source = draft('Publisher'), target = editDraft(draft('Target'), { title: 'Target typing' })
  sessions.set('draft', source); sessions.set('a', target)
  const saved = acceptDraft(source, source, { ...source, title: 'Accepted' }, base)
  sessions.bindReceipt('a', saved)
  assert.equal(sessions.get('a').token, target.token)
  sessions.update(editDraft(sessions.get('a'), { summary: 'Continued' }))
  assert.equal(sessions.get('a').title, 'Target typing')
  assert.equal(sessions.byToken(source.token).base.version, 2)
  assert.equal(sessions.recoverable(target.token)[0].token, source.token)
})
test('new drafts retain all pending and dirty owners instead of one recovery slot', () => {
  const sessions = new DraftSessions(), first = { ...draft('First'), pending: {} }, second = editDraft(draft('Second'), { title: 'Edited' })
  sessions.set('draft', first); sessions.set('draft', second); sessions.set('draft', draft('Third'))
  assert.equal(sessions.recoverable(Symbol()).length, 2)
  sessions.update(acceptDraft(sessions.byToken(first.token), first, { title: 'Accepted' }, base))
  assert.equal(sessions.recoverable(Symbol())[0].base.version, 2)
})

test('repeated clean reloads release unused copies while retained edits remain reachable', () => {
  const sessions = new DraftSessions(), edited = editDraft(draft('Keep input'), { title: 'Keep input' })
  sessions.set('a', edited)
  for (let index = 0; index < 100; index++) sessions.set('a', draft('Loaded ' + index))
  assert.equal([...sessions.values()].length, 2)
  assert.equal(sessions.recoverable(Symbol())[0].title, 'Keep input')
})

for (const status of ['succeeded', 'failed', 'cancelled', 'unknown']) test(`clean ${status} execution survives replacement, delete and repeated restoration`, () => {
  const sessions = new DraftSessions()
  const executionSnapshot = { editorText: 'GET key', executedText: 'GET key', target: '0', status }
  const original = { ...draft('Executed'), base, executionSnapshot, run: { status, error: status === 'unknown' ? 'verify first' : '' } }
  sessions.set('a', original)
  sessions.set('a', draft('Reloaded'))
  assert.equal(sessions.byToken(original.token), original)
  assert.equal(sessions.recoverable(Symbol())[0], original)
  for (let index = 0; index < 3; index++) {
    sessions.recovered(original.token); sessions.set('a', original)
    sessions.delete('a')
    assert.equal(sessions.recoverable(Symbol()).filter(item => item.token === original.token).length, 1)
  }
  assert.equal(original.dirty, false); assert.equal(original.revision, 0)
  assert.equal(original.base, base); assert.equal(original.executionPending, undefined)
})

test('a successful save acknowledges fields but retains the execution snapshot and payload', () => {
  const executionSnapshot = { editorText: 'GET key', executedText: 'GET key', target: '0', status: 'succeeded' }
  const sent = { ...editDraft(draft('  Accepted '), { summary: 'Typed' }), executionSnapshot, run: { result: 'receipt' } }
  const next = acceptDraft(sent, sent, { text: 'GET key', title: 'Accepted', summary: 'Typed', tags: '' }, base)
  assert.equal(next.dirty, false); assert.equal(next.executionSnapshot, executionSnapshot)
  assert.equal(next.run, sent.run); assert.equal(next.base, base)
})

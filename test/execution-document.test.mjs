import test from 'node:test'
import assert from 'node:assert/strict'
import { controlExecutionDocument, emptyExecutionDocument, sanitizeExecutionDocument, updateExecutionDocument, withExecutionDocumentContext } from '../src/shared/execution-document.ts'

test('execution document rejects stale AI writes after human takeover', () => {
  const initial = emptyExecutionDocument('redis', { database: '0' })
  const published = updateExecutionDocument(initial, 'GET one', 'ai', 1)
  const taken = controlExecutionDocument(published, 'user')
  assert.equal(taken.revision, 3)
  assert.throws(() => updateExecutionDocument(taken, 'SET one two', 'ai', 2), /变化/)
  assert.throws(() => updateExecutionDocument(taken, 'SET one two', 'ai', 3), /接管/)
  const edited = updateExecutionDocument(taken, 'GET two', 'user', 3)
  assert.equal(edited.text, 'GET two')
  assert.equal(edited.controller, 'user')
  assert.equal(controlExecutionDocument(edited, 'ai').controller, 'ai')
})

test('context-only redis database update is not a user edit', () => {
  const initial = emptyExecutionDocument('redis', { database: '0' })
  const published = updateExecutionDocument(initial, 'GET one', 'ai', 1)
  const patched = withExecutionDocumentContext(published, { database: '2' })
  assert.equal(patched.text, 'GET one')
  assert.equal(patched.revision, published.revision + 1)
  assert.equal(patched.controller, 'ai')
  assert.equal(patched.context.database, '2')
  assert.equal(withExecutionDocumentContext(patched, { database: '2' }), patched)
  assert.throws(() => withExecutionDocumentContext(patched, { database: '3' }, published.revision), /变化/)
  const atomic = updateExecutionDocument(patched, 'GET three', 'user', patched.revision, { database: '3' })
  assert.equal(atomic.revision, patched.revision + 1)
  assert.equal(atomic.context.database, '3')
  const edited = updateExecutionDocument(patched, 'GET two', 'user', patched.revision)
  assert.equal(edited.controller, 'user')
  assert.equal(edited.context.database, '2')
})

test('execution document sanitizes persisted text and context', () => {
  const saved = sanitizeExecutionDocument({ text: 'PING', sourceId: 'mysql', revision: -5, controller: 'user', context: { database: '0', secret: 123 } }, 'redis')
  assert.equal(saved.sourceId, 'redis')
  assert.equal(saved.revision, 1)
  assert.deepEqual(saved.context, { database: '0' })
  assert.equal(saved.controller, 'user')
})

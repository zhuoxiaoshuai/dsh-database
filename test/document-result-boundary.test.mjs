import test from 'node:test'
import assert from 'node:assert/strict'
import { sameDocumentResultTarget, documentResult, ownsDocumentResult, sqlDisplay } from '../src/shared/query-sync.ts'

const identity = { conversationId: 's', connectionId: 'c', sourceId: 'mysql', generation: 'g',
  context: { schema: 'app' }, queryRevision: 3, documentText: 'SELECT 1; SELECT 2', executedSql: 'SELECT 2', initiator: 'user' }
const document = { sourceId: 'mysql', text: identity.documentText, context: identity.context, revision: 3, controller: 'user' }
const owner = { conversationId: 's', connectionId: 'c', generation: 'g', document }
const result = { columns: ['x'], rows: [['2']], elapsedMs: 1, truncated: false }
test('live result requires complete captured identity and source payload', () => {
  const envelope = { identity, executionId: 'e', result }
  assert.equal(documentResult(envelope), envelope)
  for (const patch of [{ identity: undefined }, { result: null }, { result: {} }, { result: [] }, { executionId: '' }])
    assert.equal(documentResult({ ...envelope, ...patch }), undefined)
  assert.equal(documentResult({ ...envelope, identity: { ...identity, context: { schema: 4 } } }), undefined)
})
test('selection belongs to full document; target/revision/controller/source/session/generation all constrain current result', () => {
  assert.equal(ownsDocumentResult(identity, owner), true)
  for (const patch of [{ conversationId: 'other' }, { generation: 'g2' }, { connectionId: 'd' }, { unsaved: true }])
    assert.equal(ownsDocumentResult(identity, { ...owner, ...patch }), false)
  for (const patch of [{ sourceId: 'oracle' }, { context: { schema: 'other' } }, { revision: 4 }, { text: 'SELECT 2' }])
    assert.equal(ownsDocumentResult(identity, { ...owner, document: { ...document, ...patch } }), false)
  assert.equal(ownsDocumentResult({ ...identity, initiator: 'ai' }, owner), false)
})
test('SQL renderer target comes from original identity, not toolbar', () => {
  const projected = sqlDisplay({ identity, executionId: 'e', result })
  assert.equal(projected.schema, 'app'); assert.equal(projected.executedSql, 'SELECT 2')
  assert.equal(sqlDisplay({ identity: { ...identity, sourceId: 'redis' }, executionId: 'e', result: {} }), undefined)
})


test('accepted snapshots survive edits, saves and takeover but never cross targets', () => {
  for (const patch of [{ text: 'SELECT edited' }, { revision: 4 }, { controller: 'user' }]) {
    assert.equal(sameDocumentResultTarget({ ...identity, initiator: 'ai' }, { ...owner, document: { ...document, ...patch } }), true)
    assert.equal(ownsDocumentResult({ ...identity, initiator: 'ai' }, { ...owner, document: { ...document, ...patch } }), false)
  }
  for (const patch of [{ generation: 'new' }, { conversationId: 'new' }, { connectionId: 'new' }, { document: { ...document, sourceId: 'oracle' } }, { document: { ...document, context: { schema: 'other' } } }])
    assert.equal(sameDocumentResultTarget(identity, { ...owner, ...patch }), false)
})

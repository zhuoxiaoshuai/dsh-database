/** Installed Harness AI execution surface checks. Does not start Docker by itself. */
import assert from 'node:assert/strict'
import { format } from 'sql-formatter'

export async function installedAi(page, sessionId, connection, schema) {
  const api = body => page.evaluate(async ({ sessionId, body }) => {
    const response = await fetch('/plugins/database/connections?conversationId=' + encodeURIComponent(sessionId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }, { sessionId, body })
  const listed = await api({ action: 'execution-list' })
  assert.equal(listed.status, 200)
  assert.ok(Array.isArray(listed.body.items))
  await page.getByRole('button', { name: 'AI Query', exact: true }).click()
  await page.getByLabel('AI Query', { exact: true }).waitFor()
  if (connection) {
    const missing = await api({ action: 'execution-get', executionId: 'missing' })
    assert.equal(missing.status, 404)
    const target = { id: connection.id, generation: connection.generation }
    const formatInput = 'select id from records'
    const initial = await api({ action: 'execution-document-get', ...target })
    const saved = await api({ action: 'execution-document-update', ...target, text: formatInput, context: { schema }, revision: initial.body.document.revision })
    const controlled = await api({ action: 'execution-document-control', ...target, controller: 'ai', revision: saved.body.document.revision })
    assert.equal(controlled.status, 200)
    const before = controlled.body.document
    for (const source of ['ai', 'system']) assert.equal((await api({ action: 'shared-query-update', ...target, source, patch: { sql: 'SELECT forged' } })).status, 400)
    assert.equal((await api({ action: 'shared-query-update', ...target, patch: { sql: 'SELECT forged', lastRun: { executionId: 'forged' } } })).status, 400)
    assert.equal((await api({ action: 'shared-query-run', ...target, sql: formatInput, schema, initiator: 'ai' })).status, 400)
    assert.deepEqual((await api({ action: 'execution-document-get', ...target })).body.document, before)
    const formatted = await api({ action: 'execution-document-update', ...target, source: 'format', revision: before.revision, context: { schema },
      text: format(formatInput, { language: connection.dialect === 'oracle' ? 'plsql' : 'mysql' }) })
    assert.equal(formatted.status, 200, formatted.body.error)
    assert.equal(formatted.body.document.controller, 'ai')
    assert.equal((await api({ action: 'execution-list' })).body.items.length, listed.body.items.length, 'Rejected requests and formatting must not create records')
    const sql = 'SELECT id FROM records'
    const updated = await api({ action: 'execution-document-update', ...target, text: sql, context: { schema }, revision: formatted.body.document.revision })
    assert.equal(updated.status, 200, updated.body.error)
    const query = updated.body.document
    const executed = await api({ action: 'execution-document-run', ...target, revision: query.revision })
    assert.equal(executed.status, 200, executed.body.error)
    assert.equal(executed.body.status, 'succeeded')
    assert.equal(executed.body.result.rows[0][0], '9007199254740993')
    const explained = await api({ action: 'execution-document-run', ...target, revision: query.revision,
      text: `${connection.dialect === 'oracle' ? 'EXPLAIN PLAN FOR' : 'EXPLAIN'} ${sql}` })
    assert.equal(explained.status, 200, explained.body.error)
    assert.ok(explained.body.result.rows.length > 0)
    const after = await api({ action: 'execution-list' })
    const previousIds = new Set(listed.body.items.map(item => item.executionId))
    const created = after.body.items.filter(item => !previousIds.has(item.executionId))
    assert.equal(created.length, 2, 'Shared query and explain must each create one principal record')
    for (const [executionId, type] of [[executed.body.executionId, 'query'], [explained.body.executionId, 'explain']]) {
      const detail = await api({ action: 'execution-get', executionId })
      assert.equal(detail.status, 200)
      assert.equal(detail.body.status, 'succeeded')
      assert.equal(detail.body.type, type)
      assert.equal(detail.body.historyVisible, false)
      assert.equal(detail.body.schema, schema)
      assert.equal(detail.body.events.filter(event => event.kind === 'dispatched').length, 1)
      assert.ok(detail.body.result.rows.length > 0)
    }
  }
  return 'Installed AI tab and browser identity/field boundary, verified formatting with unchanged controller; real SQL shared query and explain: single records, one dispatch, compatible preview and visibility; no model call'
}

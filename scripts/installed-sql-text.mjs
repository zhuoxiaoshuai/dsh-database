import assert from 'node:assert/strict'

/** Uses only the caller's run-owned schema and table; no container or model setup. */
export async function installedSqlText({ api, input, originalConnection, schema }) {
  const items = async () => (await api({ action: 'execution-list' })).body.items
  for (const environment of ['sit', 'uat', 'pvt']) {
    let connection
    try {
      const opened = await api({ action: 'connect', input: { ...input, name: `${input.dialect} text ${environment}`, environment } })
      assert.equal(opened.status, 200, opened.body.error); connection = opened.body
      const target = { id: connection.id, generation: connection.generation }
      const call = (action, sql) => api({ action, ...target, input: action === 'source-execute'
        ? { text: sql, context: { schema }, entry: 'shared-query', recordPolicy: 'owned', authorized: { kind: 'write' } }
        : { sql, schema, limit: 7, lane: 'manual', authorized: { kind: 'write' } } })
      const note = async () => { const response = await call('query', 'SELECT note FROM text_flow WHERE id=1'); assert.equal(response.status, 200, response.body.error); return response.body.rows[0][0] }
      for (const action of ['query', 'manual-query', 'source-execute']) {
        const count = (await items()).length, before = await note(), marker = `${environment}_${action}`
        const allowed = true
        const updated = await call(action, `UPDATE text_flow SET note='${marker}' WHERE id=1`)
        assert.equal(updated.status, allowed ? 200 : 400, updated.body.error)
        if (allowed) { assert.equal(updated.body.affectedRows, 1); assert.equal(updated.body.executionId, undefined); assert.equal(updated.body.executionStatus, undefined) }
        assert.equal(await note(), allowed ? marker : before)
        const partial = `part_${marker}`
        const batch = await call(action, `UPDATE text_flow SET note='${partial}' WHERE id=1; DROP TABLE text_flow`)
        assert.equal(batch.status, 400)
        assert.equal(await note(), allowed ? marker : before, 'whole-batch authorization must prevent an earlier write when a later statement is invalid')
        assert.equal((await items()).length, count, 'ordinary and standard manual text must create no records')
      }
      const sql = `UPDATE text_flow SET note='shared_${environment}' WHERE id=1`
      const fresh = await api({ action: 'execution-document-get', ...target })
      const edited = await api({ action: 'execution-document-update', ...target, text: sql, context: { schema }, revision: fresh.body.document.revision })
      assert.equal(edited.status, 200)
      const previous = new Set((await items()).map(item => item.executionId)), before = await note()
      const executed = await api({ action: 'execution-document-run', ...target, revision: edited.body.document.revision })
      assert.equal(executed.status, 200, executed.body.error)
      assert.equal(await note(), `shared_${environment}`)
      const records = (await items()).filter(item => !previous.has(item.executionId))
      assert.equal(records.length, 1); assert.equal(records[0].historyVisible, false)
      assert.equal(records[0].status, 'succeeded')
      assert.equal(records[0].events.filter(event => event.kind === 'dispatched').length, 1)
    } finally {
      if (connection) assert.equal((await api({ action: 'remove', id: connection.id })).status, 200)
    }
  }
  assert.equal((await api({ action: 'activate', id: originalConnection.id })).status, 200)
  return `${input.dialect}: human SQL text allowed by account privileges in SIT/UAT/PVT, whole-batch preflight and canonical document single lifecycle verified`
}

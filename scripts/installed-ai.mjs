/** Installed Harness AI execution surface checks. Does not start Docker by itself. */
import assert from 'node:assert/strict'

export async function installedAi(page, sessionId, connection) {
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
  }
  return 'Installed plugin AI execution tab and conversation-scoped execution API responded'
}

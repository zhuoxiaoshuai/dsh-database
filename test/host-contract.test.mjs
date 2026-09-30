import test from 'node:test'
import assert from 'node:assert/strict'
import { statusForSession, statusRoute } from '../src/host-contract.ts'
test('missing or deleted host session identity is rejected; status never enables maintenance', () => {
  const sessions = { get: id => id === 'valid' ? {} : undefined }
  for (const id of [undefined, '', 'other', {}, 'x'.repeat(161)]) assert.throws(() => statusForSession(sessions, id))
  assert.equal(statusForSession(sessions, 'valid').maintenanceEnabled, false)
})
function response() { return { code: undefined, body: undefined, setHeader() {}, writeHead(code) { this.code = code }, end(body) { this.body = JSON.parse(body) } } }
test('browser status uses actual host authentication, not Origin alone', () => {
  for (const status of [401, 403]) {
    const res = response()
    statusRoute({ connection: { requestRejection: () => status }, sessions: { get() { throw new Error('must not inspect session before authentication') } } }, { method: 'GET', url: '/?conversationId=valid' }, res)
    assert.equal(res.code, status)
  }
})
test('status route rejects mutations and nonexisting sessions', () => {
  const ctx = { connection: { requestRejection: () => undefined }, sessions: { get: id => id === 'valid' ? {} : undefined } }
  for (const [method, id, code] of [['POST', 'valid', 405], ['GET', 'other', 404], ['GET', 'valid', 200]]) {
    const res = response(); statusRoute(ctx, { method, url: '/?conversationId=' + id }, res); assert.equal(res.code, code)
    if (code === 200) assert.equal(res.body.maintenanceEnabled, false)
  }
})

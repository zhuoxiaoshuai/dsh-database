import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('session factories keep credentials after input.password is cleared', () => {
  const worker = readFileSync(new URL('../src/host/connection-worker.mjs', import.meta.url), 'utf8')
  const start = worker.indexOf('const sessions = createSessionManager')
  const end = worker.indexOf('const inflight = new Map()')
  assert.ok(start >= 0 && end > start)
  const block = worker.slice(start, end)
  assert.equal(block.includes('openMysql(input'), false)
  assert.equal(block.includes('openOracle(input'), false)
  assert.equal(block.includes('probeCatalog(input.dialect, input'), false)
  assert.equal(block.includes('destroySession(input.dialect'), false)
  assert.ok(block.includes('dialect.openCatalog(credentials)'))
  assert.ok(block.includes('dialect.openMaintenance(credentials)'))
  assert.ok(block.includes('dialect.probe(conn, credentials)'))
  assert.ok(block.includes('createQueryPool: () => createDatabaseQueryPool(credentials)'))
  assert.ok(worker.includes("input.password = ''"))
})

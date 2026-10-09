import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ConnectionService } from '../src/host/connection-service.ts'
import { memoryPasswordProtector } from '../src/host/saved-connections.ts'
import { connectionInput, temporaryDirectory } from './helpers.mjs'

const workerPath = pathToFileURL(join(process.cwd(), 'test/fixtures/database-worker.mjs'))
const input = connectionInput()

function setup(t, ownerExists = () => true) {
  const directory = temporaryDirectory(t, 'database-lifecycle-')
  const url = new URL(workerPath)
  const service = new ConnectionService(ownerExists, directory, url)
  t.after(async () => { await service.dispose() })
  return { service, directory }
}

test('successful connection is saved, disconnect preserves it, and dispose terminates its worker', async t => {
  const { service } = setup(t)
  const connected = await service.open('owner-a', input, false)
  assert.equal(connected.live, true)
  assert.equal(service.list('owner-a')[0].id, connected.id)

  await service.disconnect('owner-a', connected.id)
  assert.equal(service.list('owner-a')[0].live, false)
  const active = await service.open('owner-a', input, false, connected.id)
  const pending = service.request('owner-a', active.id, active.generation, 'maintenance', { kind: 'schemas' })
  await new Promise(resolve => setTimeout(resolve, 15))
  await service.dispose()
  await assert.rejects(pending, /连接已关闭/)
})

test('reconnecting the same id changes generation and rejects the old generation', async t => {
  const { service } = setup(t)
  const first = await service.open('owner-a', input, false)
  const second = await service.open('owner-a', { ...input, name: 'updated' }, false, first.id)
  assert.equal(second.id, first.id)
  assert.notEqual(second.generation, first.generation)
  await assert.rejects(service.request('owner-a', first.id, first.generation, 'catalog', { kind: 'schemas' }), /连接已变化/)
  const result = await service.request('owner-a', second.id, second.generation, 'catalog', { kind: 'schemas' })
  assert.deepEqual(result.items, [])
})

test('workspace sessions share a live connection', async t => {
  const { service } = setup(t, owner => owner === 'owner-a' || owner === 'owner-b')
  const connected = await service.open('owner-a', input, false)
  const result = await service.request('owner-b', connected.id, connected.generation, 'catalog', { kind: 'schemas' })
  assert.deepEqual(result.items, [])
  await service.releaseOwner('owner-a')
  const after = await service.request('owner-b', connected.id, connected.generation, 'catalog', { kind: 'schemas' })
  assert.deepEqual(after.items, [])
})

test('overlapping catalog requests on one connection wait instead of failing busy', async t => {
  const { service } = setup(t)
  const connected = await service.open('owner-a', input, false)
  const first = service.request('owner-a', connected.id, connected.generation, 'catalog', { kind: 'schemas' })
  const second = service.request('owner-a', connected.id, connected.generation, 'catalog', { kind: 'tables', schema: 'app' })
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a.items, [])
  assert.deepEqual(b.items, [])
})

test('catalog cache remains isolated from caller mutations', async t => {
  const { service } = setup(t)
  const connected = await service.open('owner-a', input, false)
  const first = await service.request('owner-a', connected.id, connected.generation, 'catalog', { kind: 'schemas' })
  first.items?.push({ name: 'forged' })
  const second = await service.request('owner-a', connected.id, connected.generation, 'catalog', { kind: 'schemas' })
  assert.deepEqual(second.items, [])
})

test('aborted catalog does not make the next catalog fail busy', async t => {
  const { service } = setup(t)
  const connected = await service.open('owner-a', input, false)
  const controller = new AbortController()
  const first = service.request('owner-a', connected.id, connected.generation, 'catalog', { kind: 'schemas' }, controller.signal)
  await new Promise(resolve => setTimeout(resolve, 15))
  controller.abort()
  await assert.rejects(first, /已取消/)
  const second = await service.request('owner-a', connected.id, connected.generation, 'catalog', { kind: 'tables', schema: 'app' })
  assert.deepEqual(second.items, [])
})

test('cancelling a query does not terminate the shared worker', async t => {
  const { service } = setup(t)
  const connected = await service.open('owner-a', input, false)
  const controller = new AbortController()
  const pending = service.request('owner-a', connected.id, connected.generation, 'query', { schema: 'app', sql: "SELECT id FROM records WHERE note = 'SLEEP_TEST'" }, controller.signal)
  await new Promise(resolve => setTimeout(resolve, 30))
  controller.abort()
  await assert.rejects(pending, /已取消/)
  const after = await service.request('owner-a', connected.id, connected.generation, 'catalog', { kind: 'schemas' })
  assert.deepEqual(after.items, [])
})

test('worker structured error codes survive Host dispatch without message inference', async t => {
  const { service } = setup(t)
  const connected = await service.open('owner-a', input, false)
  for (const [marker, code] of [
    ['STRUCTURED_BUSY', 'connection_busy'],
    ['STRUCTURED_CANCELLED', 'request_cancelled'],
    ['STRUCTURED_TIMEOUT', 'connection_timeout'],
    ['STRUCTURED_OFFLINE', 'connection_offline'],
  ]) {
    await assert.rejects(
      service.request('owner-a', connected.id, connected.generation, 'manual-query', { schema: 'app', sql: `SELECT ${marker}` }),
      error => error?.code === code && error?.message === '文案不包含分类关键字',
    )
  }
})

test('query tabs stay per conversation; visible schemas and last active are shared', async t => {
  const { service, directory } = setup(t, owner => owner === 'owner-a' || owner === 'owner-b')
  const connected = await service.open('owner-a', input, false)
  service.activate('owner-a', connected.id)
  service.saveWorkbench('owner-a', connected.id, { queryTabs: [{ id: 'a', name: 'A', sql: 'SELECT a' }], visibleSchemas: ['app'] })
  const other = service.snapshot('owner-b')
  assert.equal(Object.hasOwn(other, 'openIds'), false)
  assert.equal(other.lastActiveId, connected.id)
  assert.equal(other.connections[0].workbench?.queryTabs, undefined)
  assert.deepEqual(other.connections[0].workbench?.visibleSchemas, ['app'])
  assert.equal(service.snapshot('owner-a').connections[0].workbench?.queryTabs?.[0].sql, 'SELECT a')
  const disk = JSON.parse(readFileSync(join(directory, 'database-workspace.json'), 'utf8'))
  assert.equal(disk.lastActiveId, connected.id)
  assert.equal(disk.openIds, undefined)
  assert.deepEqual(disk.connections[0].visibleSchemas, ['app'])
  assert.equal(disk.connections[0].workbench, undefined)
})

test('two live connections run requests independently', async t => {
  const { service } = setup(t)
  const first = await service.open('owner-a', input, false)
  const second = await service.open('owner-a', { ...input, name: 'other', database: 'other' }, false)
  const slow = service.request('owner-a', first.id, first.generation, 'query', { schema: 'app', sql: "SELECT id FROM records WHERE note = 'SLEEP_TEST'" })
  const started = Date.now()
  const fast = await service.request('owner-a', second.id, second.generation, 'catalog', { kind: 'schemas' })
  assert.ok(Date.now() - started < 1500)
  assert.deepEqual(fast.items, [])
  await slow
})

test('maintenance in progress blocks update; disconnect waits then closes', async t => {
  const { service } = setup(t)
  const connected = await service.open('owner-a', input, false)
  const pending = service.request('owner-a', connected.id, connected.generation, 'maintenance', { kind: 'schemas' })
  await new Promise(resolve => setTimeout(resolve, 15))
  await assert.rejects(service.update('owner-a', connected.id, { ...input, name: 'blocked' }), /维护操作正在执行/)
  const disconnecting = service.disconnect('owner-a', connected.id)
  await pending
  await disconnecting
  assert.equal(service.list('owner-a')[0].live, false)
})

test('workspace snapshot revision increases on connect and disconnect', async t => {
  const { service } = setup(t)
  const before = service.snapshot('owner-a').revision
  const connected = await service.open('owner-a', input, false)
  const live = service.snapshot('owner-a').revision
  assert.ok(live > before)
  await service.disconnect('owner-a', connected.id)
  assert.ok(service.snapshot('owner-a').revision > live)
})

test('disconnect during a query waits then closes the connection', async t => {
  const { service } = setup(t)
  const connected = await service.open('owner-a', input, false)
  const slow = service.request('owner-a', connected.id, connected.generation, 'query', { schema: 'app', sql: "SELECT id FROM records WHERE note = 'SLEEP_TEST'" })
  await new Promise(resolve => setTimeout(resolve, 30))
  await service.disconnect('owner-a', connected.id)
  const settled = await Promise.allSettled([slow])
  assert.equal(service.list('owner-a')[0].live, false)
  assert.ok(settled[0].status === 'fulfilled' || /连接已关闭|已变化|已取消/.test(String(settled[0].reason)))
})

test('catalog and query reject a schema this connection does not own without hitting the worker', async t => {
  const { service } = setup(t)
  const connected = await service.open('owner-a', input, false)
  assert.deepEqual(connected.databases, [])
  await assert.rejects(
    service.request('owner-a', connected.id, connected.generation, 'catalog', { kind: 'tables', schema: 'nl_risk' }),
    /当前连接无权访问此数据库/,
  )
  await assert.rejects(
    service.request('owner-a', connected.id, connected.generation, 'query', { schema: 'nl_risk', sql: 'SELECT 1' }),
    /当前连接无权访问此数据库/,
  )
  const tables = await service.request('owner-a', connected.id, connected.generation, 'catalog', { kind: 'tables', schema: 'app' })
  assert.deepEqual(tables.items, [])
})

test('live connection quota is atomic across concurrent opens', async t => {
  const { service } = setup(t)
  await service.open('owner-a', input, false)
  const extras = []
  for (let index = 0; index < 19; index++) extras.push(await service.open('owner-a', { ...input, name: `extra-${index}`, database: `db${index}` }, false))
  await assert.rejects(service.open('owner-a', { ...input, name: 'overflow', database: 'overflow' }, false), /上限/)
  assert.equal(service.list('owner-a').filter(item => item.live).length, 20)
})

test('handshake ready does not include catalog databases', async t => {
  const { service } = setup(t)
  const connected = await service.open('owner-a', input, false)
  assert.equal(connected.health, 'ready')
  assert.deepEqual(connected.databases, [])
  assert.equal(connected.live, true)
})

test('same-login reconnect changes generation and keeps the saved profile', async t => {
  const { service } = setup(t)
  const first = await service.open('owner-a', input, false)
  const second = await service.open('owner-a', input, false, first.id)
  assert.equal(second.id, first.id)
  assert.notEqual(second.generation, first.generation)
  assert.equal(second.live, true)
  assert.equal(service.list('owner-a')[0].live, true)
  await assert.rejects(service.request('owner-a', first.id, first.generation, 'catalog', { kind: 'schemas' }), /连接已变化/)
  const result = await service.request('owner-a', second.id, second.generation, 'catalog', { kind: 'schemas' })
  assert.deepEqual(result.items, [])
})

test('failed edited password preserves the original live session and saved profile', async t => {
  const directory = temporaryDirectory(t, 'database-lifecycle-')
  const url = pathToFileURL(join(process.cwd(), 'test/fixtures/session-reconnect-fail-worker.mjs'))
  const service = new ConnectionService(() => true, directory, url)
  t.after(async () => { await service.dispose() })
  const first = await service.open('owner-a', input, false)
  await assert.rejects(service.open('owner-a', { ...input, password: 'wrong' }, false, first.id), /CatalogSession|无法建立/)
  const listed = service.list('owner-a')[0]
  assert.equal(listed.id, first.id)
  assert.equal(listed.live, true)
  assert.equal(listed.health, 'ready')
  assert.equal(listed.generation, first.generation)
})

test('user SQL is executed once and never auto-replayed', async t => {
  const directory = temporaryDirectory(t, 'database-lifecycle-')
  const url = pathToFileURL(join(process.cwd(), 'test/fixtures/session-runtime-worker.mjs'))
  const service = new ConnectionService(() => true, directory, url)
  t.after(async () => { await service.dispose() })
  const connected = await service.open('owner-a', input, false)
  const first = await service.request('owner-a', connected.id, connected.generation, 'query', { schema: 'app', sql: 'SELECT 1' })
  const second = await service.request('owner-a', connected.id, connected.generation, 'query', { schema: 'app', sql: 'SELECT 1' })
  assert.equal(first.rows[0][0], '1')
  assert.equal(second.rows[0][0], '2')
  assert.equal(first.trustedAuthorization, true)
})

test('ordinary query and manual-query share the human quota regardless of action name', async t => {
  const { service } = setup(t)
  const connected = await service.open('owner-a', input, false)
  const hold = { schema: 'app', sql: "SELECT id FROM records WHERE note = 'SLEEP_TEST'" }
  const first = service.request('owner-a', connected.id, connected.generation, 'query', hold)
  const second = service.request('owner-a', connected.id, connected.generation, 'query', hold)
  await new Promise(resolve => setTimeout(resolve, 40))
  const third = await service.request('owner-a', connected.id, connected.generation, 'query', { schema: 'app', sql: 'SELECT 1' })
  assert.ok(third.rows)
  const manual = await service.request('owner-a', connected.id, connected.generation, 'manual-query', { schema: 'app', sql: 'SELECT 1' })
  assert.deepEqual(manual.rows, [['1', 'secret-value']])
  await Promise.all([first, second])
})

test('a saturated connection does not block another connection query or catalog', async t => {
  const { service } = setup(t)
  const first = await service.open('owner-a', input, false)
  const second = await service.open('owner-a', { ...input, name: 'other', database: 'other' }, false)
  const hold = { schema: 'app', sql: "SELECT id FROM records WHERE note = 'SLEEP_TEST'" }
  const busyA = [
    service.request('owner-a', first.id, first.generation, 'query', hold),
    service.request('owner-a', first.id, first.generation, 'query', hold),
  ]
  await new Promise(resolve => setTimeout(resolve, 40))
  const started = Date.now()
  const queryB = await service.request('owner-a', second.id, second.generation, 'query', { schema: 'other', sql: 'SELECT 1' })
  const catalogB = await service.request('owner-a', second.id, second.generation, 'catalog', { kind: 'schemas' })
  assert.ok(Date.now() - started < 1500)
  assert.deepEqual(queryB.rows, [['1', 'secret-value']])
  assert.deepEqual(catalogB.items, [])
  await Promise.all(busyA)
})

test('idle revive restores health without changing generation', async t => {
  const directory = temporaryDirectory(t, 'database-lifecycle-')
  const url = pathToFileURL(join(process.cwd(), 'test/fixtures/session-revive-worker.mjs'))
  const service = new ConnectionService(() => true, directory, url)
  t.after(async () => { await service.dispose() })
  const connected = await service.open('owner-a', input, false)
  const generation = connected.generation
  const deadline = Date.now() + 4000
  let sawDegraded = false
  while (Date.now() < deadline) {
    const row = service.list('owner-a')[0]
    if (row.health === 'degraded') sawDegraded = true
    if (sawDegraded && row.health === 'ready') {
      assert.equal(row.generation, generation)
      assert.equal(row.live, true)
      return
    }
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  assert.fail(`expected revive to ready, last health=${service.list('owner-a')[0].health}`)
})

test('failed revive stops after four attempts and does not take down another connection', async t => {
  const directory = temporaryDirectory(t, 'database-lifecycle-')
  const moduleUrl = pathToFileURL(join(process.cwd(), 'test/fixtures/session-revive-worker.mjs'))
  moduleUrl.searchParams.set('failRevive', '1')
  // Worker entry URLs normalize away file URL queries; a data entry preserves
  // the search params on the imported fixture module's import.meta.url.
  const url = new URL(`data:text/javascript,import ${JSON.stringify(moduleUrl.href)}`)
  const service = new ConnectionService(() => true, directory, url)
  t.after(async () => { await service.dispose() })
  const first = await service.open('owner-a', input, false)
  const second = await service.open('owner-a', { ...input, name: 'other', database: 'other' }, false)
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if (service.list('owner-a').find(row => row.id === first.id)?.health === 'offline') break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const listed = service.list('owner-a')
  const failed = listed.find(row => row.id === first.id)
  const healthy = listed.find(row => row.id === second.id)
  assert.equal(failed?.health, 'offline')
  assert.equal(failed?.live, false)
  assert.equal(healthy?.health, 'ready')
  assert.equal(healthy?.live, true)
  const catalog = await service.request('owner-a', second.id, second.generation, 'catalog', { kind: 'schemas' })
  assert.deepEqual(catalog.items, [])
  await new Promise(resolve => setTimeout(resolve, 600))
  assert.equal(service.list('owner-a').find(row => row.id === first.id)?.health, 'offline')
})

test('same-login recover keeps generation and does not run reconnect', async t => {
  const directory = temporaryDirectory(t, 'database-lifecycle-')
  const url = pathToFileURL(join(process.cwd(), 'test/fixtures/session-revive-worker.mjs'))
  const service = new ConnectionService(() => true, directory, url, memoryPasswordProtector)
  t.after(async () => { await service.dispose() })
  const connected = await service.open('owner-a', { ...input, rememberPassword: true }, false)
  const generation = connected.generation
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    if (service.list('owner-a')[0].health === 'degraded') break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(service.list('owner-a')[0].health, 'degraded')
  const recovered = await service.update('owner-a', connected.id, { ...input, password: '', useSavedPassword: true, rememberPassword: true })
  assert.equal(recovered.generation, generation)
  assert.equal(recovered.health, 'ready')
  assert.equal(recovered.live, true)
  assert.equal(recovered.version, 'session-revive-1')
})

test('failed recover keeps the profile offline without changing generation', async t => {
  const directory = temporaryDirectory(t, 'database-lifecycle-')
  const moduleUrl = pathToFileURL(join(process.cwd(), 'test/fixtures/session-revive-worker.mjs'))
  moduleUrl.searchParams.set('failRevive', '1')
  const url = new URL(`data:text/javascript,import ${JSON.stringify(moduleUrl.href)}`)
  const service = new ConnectionService(() => true, directory, url, memoryPasswordProtector)
  t.after(async () => { await service.dispose() })
  const connected = await service.open('owner-a', { ...input, rememberPassword: true }, false)
  const generation = connected.generation
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if (service.list('owner-a')[0].health === 'offline') break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(service.list('owner-a')[0].health, 'offline')
  await assert.rejects(
    service.update('owner-a', connected.id, { ...input, password: '', useSavedPassword: true, rememberPassword: true }),
    /无法恢复 CatalogSession/,
  )
  const listed = service.list('owner-a')[0]
  assert.equal(listed.health, 'offline')
  assert.equal(listed.live, false)
  assert.equal(listed.generation, generation)
  assert.notEqual(listed.version, 'session-reconnected')
})

test('saved-password reconnect after disconnect creates a new worker', async t => {
  const directory = temporaryDirectory(t, 'database-lifecycle-')
  const url = pathToFileURL(join(process.cwd(), 'test/fixtures/database-worker.mjs'))
  const service = new ConnectionService(() => true, directory, url, memoryPasswordProtector)
  t.after(async () => { await service.dispose() })
  const connected = await service.open('owner-a', { ...input, rememberPassword: true }, false)
  await service.disconnect('owner-a', connected.id)
  const reopened = await service.open('owner-a', { ...input, password: '', useSavedPassword: true, rememberPassword: true }, false, connected.id)
  assert.equal(reopened.id, connected.id)
  assert.notEqual(reopened.generation, connected.generation)
  assert.equal(reopened.live, true)
  const catalog = await service.request('owner-a', reopened.id, reopened.generation, 'catalog', { kind: 'schemas' })
  assert.deepEqual(catalog.items, [])
})

test('changed login still replaces the worker after a test connection', async t => {
  const { service } = setup(t)
  const first = await service.open('owner-a', input, false)
  const second = await service.open('owner-a', { ...input, database: 'other', name: 'other' }, false, first.id)
  assert.equal(second.id, first.id)
  assert.notEqual(second.generation, first.generation)
  assert.equal(second.database, 'other')
})


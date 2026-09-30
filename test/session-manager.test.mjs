import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionManager, isFatalCatalogSessionError, SESSION_QUOTA } from '../src/host/session-manager.mjs'

test('profile session quota is catalog 1, query 3, maintenance 1, hard cap 5', () => {
  assert.equal(SESSION_QUOTA.catalog, 1)
  assert.equal(SESSION_QUOTA.query, 3)
  assert.equal(SESSION_QUOTA.maintenance, 1)
  assert.equal(SESSION_QUOTA.profile, 5)
  assert.equal(SESSION_QUOTA.catalog + SESSION_QUOTA.query + SESSION_QUOTA.maintenance, SESSION_QUOTA.profile)
})

test('permission and missing-object errors are not fatal catalog session errors', () => {
  assert.equal(isFatalCatalogSessionError(new Error('无权读取此库。')), false)
  assert.equal(isFatalCatalogSessionError(Object.assign(new Error('missing'), { code: 'ER_NO_SUCH_TABLE' })), false)
  assert.equal(isFatalCatalogSessionError(Object.assign(new Error('lost'), { code: 'PROTOCOL_CONNECTION_LOST' })), true)
  assert.equal(isFatalCatalogSessionError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true)
})

function manager() {
  let created = 0
  const sessions = createSessionManager({
    dialect: 'mysql',
    async createCatalog() {
      created += 1
      return { id: created, destroy() {} }
    },
    async createMaintenance() {
      return { id: 'm' }
    },
    async destroy() {},
    async probe(conn) {
      return { version: '8.0', database: 'app', identity: JSON.stringify(['plugin', 'reader']), conn }
    },
  })
  return { sessions, created: () => created }
}

test('probe session is reused as the catalog session', async () => {
  const { sessions, created } = manager()
  const first = await sessions.ensureCatalog()
  const second = await sessions.ensureCatalog()
  assert.equal(first, second)
  assert.equal(created(), 1)
  assert.equal(sessions.health, 'ready')
  assert.equal(sessions.stats().total, 1)
  await sessions.close()
})

test('catalog fatal session error retries once then degrades', async () => {
  const { sessions, created } = manager()
  await sessions.ensureCatalog()
  let runs = 0
  await assert.rejects(sessions.withCatalog(async () => {
    runs += 1
    throw Object.assign(new Error('lost'), { code: 'PROTOCOL_CONNECTION_LOST' })
  }), /lost/)
  assert.equal(runs, 2)
  assert.equal(created(), 2)
  assert.equal(sessions.health, 'degraded')
  await sessions.close()
})

test('catalog permission errors do not retry or degrade', async () => {
  const { sessions, created } = manager()
  await sessions.ensureCatalog()
  let runs = 0
  await assert.rejects(sessions.withCatalog(async () => {
    runs += 1
    throw new Error('无权读取此库。')
  }), /无权/)
  assert.equal(runs, 1)
  assert.equal(created(), 1)
  assert.equal(sessions.health, 'ready')
  await sessions.close()
})

test('mysql cancel destroys the catalog session and frees the lane', async () => {
  const { sessions } = manager()
  await sessions.ensureCatalog()
  const controller = new AbortController()
  const pending = sessions.withCatalog(async () => {
    controller.abort()
    throw Object.assign(new Error('读取已取消。'), { cancelled: true })
  }, controller.signal)
  await assert.rejects(pending, /取消/)
  assert.equal(sessions.stats().catalog, 0)
  await sessions.withCatalog(async conn => conn)
  assert.equal(sessions.stats().catalog, 1)
  await sessions.close()
})

test('query session death does not mark the profile offline', async () => {
  const { sessions } = manager()
  await sessions.ensureCatalog()
  assert.equal(sessions.health, 'ready')
  sessions.markDegraded()
  assert.notEqual(sessions.health, 'offline')
  await sessions.close()
})

test('recoverCatalog reuses a live catalog after probe without rebuilding the query pool', async () => {
  let created = 0
  let probed = 0
  let closed = 0
  const sessions = createSessionManager({
    dialect: 'mysql',
    async createCatalog() {
      created += 1
      return { id: created }
    },
    async createMaintenance() { return { id: 'm' } },
    async destroy() {},
    async probe(conn) {
      probed += 1
      return { version: '8.0', database: 'app', identity: 'reader', conn }
    },
    createQueryPool: () => ({
      stats: () => ({ live: 1 }),
      close: async () => { closed += 1 },
    }),
  })
  const first = await sessions.ensureCatalog()
  const recovered = await sessions.recoverCatalog()
  assert.equal(recovered, first)
  assert.equal(created, 1)
  assert.equal(probed, 2)
  assert.equal(closed, 0)
  assert.equal(sessions.health, 'ready')
  await sessions.close()
})

test('recoverCatalog replaces a zombie catalog once and leaves the query pool', async () => {
  let created = 0
  let probed = 0
  let closed = 0
  const sessions = createSessionManager({
    dialect: 'mysql',
    async createCatalog() {
      created += 1
      return { id: created, live: true }
    },
    async createMaintenance() { return { id: 'm' } },
    async destroy() {},
    async probe(conn) {
      probed += 1
      if (!conn.live) throw new Error('catalog socket closed')
      return { version: '8.0', database: 'app', identity: 'reader' }
    },
    createQueryPool: () => ({
      stats: () => ({ live: 1 }),
      close: async () => { closed += 1 },
    }),
  })
  await sessions.ensureCatalog()
  sessions.catalogConnection().live = false
  const recovered = await sessions.recoverCatalog()
  assert.equal(recovered.id, 2)
  assert.equal(created, 2)
  assert.equal(probed, 3)
  assert.equal(closed, 0)
  assert.equal(sessions.health, 'ready')
  await sessions.close()
})

test('recoverCatalog creates when no catalog exists', async () => {
  const { sessions, created } = manager()
  const recovered = await sessions.recoverCatalog()
  assert.equal(recovered.id, 1)
  assert.equal(created(), 1)
  assert.equal(sessions.health, 'ready')
  await sessions.close()
})

test('catalog fatal retry does not probe the destroyed session', async () => {
  let created = 0
  let probed = 0
  const sessions = createSessionManager({
    dialect: 'mysql',
    async createCatalog() {
      created += 1
      return { id: created }
    },
    async createMaintenance() { return { id: 'm' } },
    async destroy() {},
    async probe() {
      probed += 1
      return { version: '8.0', database: 'app', identity: 'reader' }
    },
  })
  await sessions.ensureCatalog()
  await assert.rejects(sessions.withCatalog(async () => {
    throw Object.assign(new Error('lost'), { code: 'PROTOCOL_CONNECTION_LOST' })
  }), /lost/)
  assert.equal(created, 2)
  assert.equal(probed, 2)
  assert.equal(sessions.health, 'degraded')
  await sessions.close()
})

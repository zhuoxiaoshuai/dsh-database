import test from 'node:test'
import assert from 'node:assert/strict'
import { createReadonlyQueryPool, isFatalSessionError } from '../src/host/query-pool.mjs'
import { executeSelect, executeSql } from '../src/host/query.mjs'

test('readonly pool reuses reset connections and isolates concurrent borrows', async () => {
  let created = 0, destroyed = 0, prepares = 0, resets = 0
  const pool = createReadonlyQueryPool({
    size: 2,
    async create() {
      created += 1
      return { id: created }
    },
    async prepare(_conn, schema) { prepares += 1; assert.equal(schema, 'biz') },
    async reset() { resets += 1 },
    async destroy() { destroyed += 1 },
  })
  const first = await pool.acquire('biz')
  const second = await pool.acquire('biz')
  assert.notEqual(first.connection.id, second.connection.id)
  const waiting = pool.acquire('biz')
  await first.release()
  const third = await waiting
  assert.equal(third.connection.id, first.connection.id)
  await second.release()
  await third.release()
  assert.equal(created, 2)
  assert.equal(prepares, 3)
  assert.equal(resets, 3)
  assert.equal(destroyed, 0)
  await pool.close()
  assert.equal(destroyed, 2)
})

test('pool discards cancelled waiters and fatal sessions', async () => {
  const pool = createReadonlyQueryPool({
    size: 1,
    async create() { return { id: 1 } },
    async prepare() {},
    async reset() { throw new Error('PROTOCOL_CONNECTION_LOST') },
    async destroy() {},
  })
  const leased = await pool.acquire('biz')
  const controller = new AbortController()
  const pending = pool.acquire('biz', controller.signal)
  controller.abort()
  await assert.rejects(pending, /取消/)
  await leased.release()
  assert.equal(pool.stats().idle, 0)
  await pool.close()
})

test('schema switch happens on borrow', async () => {
  const schemas = []
  const pool = createReadonlyQueryPool({
    size: 1,
    async create() { return { id: 1 } },
    async prepare(_conn, schema) { schemas.push(schema) },
    async reset() {},
    async destroy() {},
  })
  const first = await pool.acquire('one')
  await first.release()
  const second = await pool.acquire('two')
  await second.release()
  assert.deepEqual(schemas, ['one', 'two'])
  await pool.close()
})

test('pool retries acquire after a failed prepare without replaying SQL', async () => {
  let created = 0, prepares = 0
  const pool = createReadonlyQueryPool({
    size: 2,
    async create() { created += 1; return { id: created } },
    async prepare(conn) {
      prepares += 1
      if (conn.id === 1) throw new Error('PROTOCOL_CONNECTION_LOST')
    },
    async reset() {},
    async destroy() {},
  })
  const leased = await pool.acquire('biz')
  assert.equal(leased.connection.id, 2)
  assert.equal(created, 2)
  assert.equal(prepares, 2)
  await leased.release()
  await pool.close()
})

test('executeSelect does not re-authorize when policy is provided', async () => {
  await assert.rejects(
    executeSelect({ sql: 'SELECT 1', schema: 'biz', limit: 1 }, { dialect: 'mysql' }, undefined, { authorized: { kind: 'write', sql: 'SELECT 1' } }),
    /只允许单条 SELECT/,
  )
})

test('executeSql reuses authorizeStatement result for write routing', async () => {
  await assert.rejects(
    executeSql(
      { sql: 'UPDATE t SET x = 1', schema: 'biz', lane: 'manual' },
      { dialect: 'mysql', environment: 'sit', host: '127.0.0.1', port: 1, username: 'u', password: 'p', identity: 'x' },
      undefined,
      undefined,
      { kind: 'write', sql: 'UPDATE t SET x = 1', tables: ['t'], targets: [{ schema: 'biz', name: 't' }] },
    ),
  )
})

test('fatal session errors include protocol and identity failures', () => {
  assert.equal(isFatalSessionError(new Error('PROTOCOL_CONNECTION_LOST')), true)
  assert.equal(isFatalSessionError(new Error('数据库实例或账号身份发生变化，请重新连接。')), true)
  assert.equal(isFatalSessionError(new Error('syntax'), { truncated: false }), false)
  assert.equal(isFatalSessionError(new Error('ok'), { truncated: true }), true)
})

import test from 'node:test'
import assert from 'node:assert/strict'

test('cancelled late creation holds physical capacity until orphan destruction finishes', async () => {
  let finishOpen, finishDestroy, created = 0, physical = 0
  const pool = createReadonlyQueryPool({ size: 1,
    create: () => { physical++; return ++created === 1 ? new Promise(resolve => { finishOpen = resolve }) : Promise.resolve({ id: created }) },
    prepare: async () => {}, reset: async () => {},
    destroy: async conn => { if (conn.id === 1) await new Promise(resolve => { finishDestroy = resolve }); physical-- } })
  const abort = new AbortController()
  const first = pool.acquire('app', abort.signal)
  abort.abort()
  await assert.rejects(first, /取消/)
  const waiting = pool.acquire('app')
  finishOpen({ id: 1 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(created, 1)
  assert.equal(physical, 1)
  assert.equal(pool.stats().creating, 1)
  assert.equal(pool.stats().waiting, 1)
  finishDestroy()
  const lease = await waiting
  assert.equal(physical, 1)
  assert.equal(lease.connection.id, 2)
  await lease.release(); await pool.close()
  assert.equal(physical, 0)
})

test('stalled orphan destruction closes the pool while retaining its reservation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finishOpen, finishDestroy, created = 0, stalls = 0
  const pool = createReadonlyQueryPool({ size: 1, operationTimeoutMs: 10,
    create: () => { created++; return new Promise(resolve => { finishOpen = resolve }) },
    prepare: async () => {}, reset: async () => {},
    destroy: () => new Promise(resolve => { finishDestroy = resolve }), onStall: () => { stalls++ } })
  const abort = new AbortController(), first = pool.acquire('app', abort.signal)
  abort.abort(); await assert.rejects(first, /取消/)
  const rejected = assert.rejects(pool.acquire('app'), /超时/)
  finishOpen({ id: 1 })
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(10)
  await rejected
  assert.equal(stalls, 1); assert.equal(created, 1)
  assert.equal(pool.stats().closed, true); assert.equal(pool.stats().creating, 1)
  finishDestroy()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pool.stats().creating, 0)
  await pool.close()
})

test('cancelled late connection creation retains its reservation and destroys the orphan', async () => {
  let release, created = 0
  const destroyed = []
  const pool = createReadonlyQueryPool({size:1,create:() => {created++; return new Promise(resolve => {release = resolve})},prepare:async () => {},reset:async () => {},destroy:async conn => {destroyed.push(conn.id)}})
  const controller = new AbortController()
  const pending = pool.acquire('app',controller.signal)
  controller.abort()
  await assert.rejects(pending, /取消/)
  assert.equal(pool.stats().creating,1)
  await pool.close()
  release({id:'late'})
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(destroyed,['late'])
  assert.equal(pool.stats().creating,0)
  assert.equal(pool.stats().live,0)
  assert.equal(created,1)
})

test('a stalled destroy closes the pool and cannot free physical capacity prematurely', async t => {
  t.mock.timers.enable({apis:['setTimeout']})
  let releaseDestroy, created = 0, stalls = 0
  const pool = createReadonlyQueryPool({size:1,operationTimeoutMs:10,create:async()=>({id:++created}),prepare:async()=>{},reset:async()=>{},
    destroy:()=>new Promise(resolve=>{releaseDestroy = resolve}),onStall:()=>{stalls++}})
  const lease = await pool.acquire('app')
  const queued = pool.acquire('app')
  const rejected = assert.rejects(queued, /超时/)
  const discarding = lease.discard()
  await new Promise(resolve=>setImmediate(resolve))
  t.mock.timers.tick(10)
  await discarding; await rejected
  assert.equal(stalls,1); assert.equal(created,1)
  assert.equal(pool.stats().live,1); assert.equal(pool.stats().closed,true)
  releaseDestroy()
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(pool.stats().live,0)
})

test('pool creation failure releases capacity for an already queued borrower', async () => {
  let rejectFirst, calls = 0
  const pool = createReadonlyQueryPool({ size: 1, create: () => ++calls === 1 ? new Promise((_, reject) => { rejectFirst = reject }) : Promise.resolve({ id: calls }),
    prepare: async () => {}, reset: async () => {}, destroy: async () => {} })
  const first = pool.acquire('app').catch(error => error)
  const second = pool.acquire('app')
  rejectFirst(new Error('network unavailable'))
  assert.match((await first).message, /network unavailable/)
  const lease = await second
  assert.equal(lease.connection.id, 2)
  await lease.release(); await pool.close()
})

test('pool preparation and reset deadlines retire only their physical session', async () => {
  let count = 0, destroyed = 0
  const pool = createReadonlyQueryPool({ size: 1, operationTimeoutMs: 15, create: async () => ({ id: ++count }),
    prepare: async conn => { if (conn.id === 1) await new Promise(() => {}) }, reset: async () => new Promise(() => {}), destroy: async () => { destroyed++ } })
  const lease = await pool.acquire('app')
  assert.equal(lease.connection.id, 2)
  await lease.release()
  assert.equal(destroyed, 2)
  assert.equal(pool.stats().live, 0)
  await pool.close()
})
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

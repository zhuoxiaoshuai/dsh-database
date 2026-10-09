import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { mysqlDialect, trackMysqlConnection } from '../src/host/data-sources/mysql/driver.mjs'
import { mysqlConnectionConfig } from '../src/host/data-sources/mysql/connection.mjs'
import { createReadonlyQueryPool } from '../src/host/query-pool.mjs'
import { createSessionManager, startIdleCatalogProbe } from '../src/host/session-manager.mjs'
import { formatMysqlValue, isBinaryCell } from '../src/host/cell-value.mjs'
import { clipResultPreview } from '../src/shared/execution.ts'
import { createDmlPlan } from '../src/host/dml-plan.mjs'
import mysql from 'mysql2'
import { ConnectionService } from '../src/host/connection-service.ts'
import { exportResult } from '../src/shared/workbench.ts'
import { temporaryDirectory, connectionInput } from './helpers.mjs'

const connection = () => Object.assign(new EventEmitter(), { destroy() { this.emit('end') } })
const loss = conn => { conn.emit('error', Object.assign(new Error('closed'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true })); conn.emit('end') }

test('MySQL connection-level idle errors notify once, and intentional destroy does not report loss', async () => {
  const conn = trackMysqlConnection(connection()); let notices = 0
  mysqlDialect.watchConnection(conn, () => ++notices)
  loss(conn); loss(conn)
  assert.equal(notices, 1)
  const intentional = trackMysqlConnection(connection())
  mysqlDialect.watchConnection(intentional, () => ++notices)
  await mysqlDialect.destroy(intentional)
  loss(intentional)
  assert.equal(notices, 1)
})

test('idle pool loss frees capacity; active loss drains once and wakes the waiting request', async t => {
  let created = 0, destroyed = 0
  const pool = createReadonlyQueryPool({ size: 1, create: async () => { ++created; return trackMysqlConnection(connection()) },
    prepare: async () => {}, reset: async () => {}, destroy: async conn => { ++destroyed; await mysqlDialect.destroy(conn) }, watchConnection: mysqlDialect.watchConnection })
  t.after(() => pool.close())
  const first = await pool.acquire('app'); await first.release(); loss(first.connection)
  await delay(0)
  assert.equal(pool.stats().live, 0); assert.equal(pool.stats().idle, 0)
  const second = await pool.acquire('app'), waiting = pool.acquire('app')
  loss(second.connection)
  assert.equal(pool.stats().live, 1, 'checked-out loss belongs to its existing request')
  await second.release()
  const third = await waiting
  await second.discard()
  assert.equal(created, 3); assert.equal(destroyed, 2); assert.equal(pool.stats().live, 1)
  await third.release()
})

test('Catalog idle loss publishes degraded and recovers without replacing the query pool', async t => {
  const health = [], pool = { close: async () => {}, stats: () => ({ live: 0 }) }; let created = 0
  const sessions = createSessionManager({ dialect: 'mysql', createCatalog: async () => { ++created; return trackMysqlConnection(connection()) },
    probe: async () => ({ version: '8', database: 'app', identity: 'same' }), destroy: mysqlDialect.destroy,
    watchConnection: mysqlDialect.watchConnection, createQueryPool: () => pool, onHealth: value => health.push(value) })
  t.after(() => sessions.close())
  const first = await sessions.ensureCatalog(); loss(first)
  assert.equal(sessions.health, 'degraded'); assert.equal(sessions.catalogConnection(), undefined)
  assert.equal(await sessions.withCatalog(conn => conn), sessions.catalogConnection())
  assert.equal(sessions.health, 'ready'); assert.equal(created, 2); assert.equal(sessions.queryPool(), pool)
  assert.deepEqual(health, ['ready', 'degraded', 'ready'])
})

test('idle probe skips busy work, never overlaps, degrades on failure, and stops cleanly', async () => {
  let busy = true, probes = 0, finish, health = 'ready'
  const sessions = { get health() { return health }, probeCatalog: () => { ++probes; return new Promise((resolve, reject) => { finish = reject }) }, markDegraded: () => { health = 'degraded' } }
  const stop = startIdleCatalogProbe(sessions, work => work(), () => busy, 5)
  try {
    await delay(20); assert.equal(probes, 0)
    busy = false; await delay(20); assert.equal(probes, 1)
    await delay(20); assert.equal(probes, 1)
    finish(new Error('lost')); await delay(10); assert.equal(health, 'degraded')
    stop(); health = 'ready'; await delay(20); assert.equal(probes, 1)
  } finally { stop() }
})

test('real MySQL row conversion preserves readable bytes, JSON digits, BIT and geometry with binary metadata', async () => {
  assert.equal(mysqlConnectionConfig({}).jsonStrings, true)
  const fields = [{ name: 'text', columnType: 253, characterSet: 45 }, { name: 'blob', columnType: 252, characterSet: 63 },
    { name: 'invalid', columnType: 252, characterSet: 63 }, { name: 'json', columnType: 245, characterSet: 63 },
    { name: 'bit', columnType: 16, characterSet: 63 }, { name: 'geometry', columnType: 255, characterSet: 63 }]
  const values = ['[BLOB 4 bytes]', Buffer.from('中文 abcd'), Buffer.from([255, 0]), '{"id":9007199254740993}', Buffer.from([5]), { x: 1, y: 2 }]
  const query = new EventEmitter(), stream = new EventEmitter()
  const conn = { stream, query() { queueMicrotask(() => { query.emit('fields', fields); query.emit('result', values); query.emit('end') }); return query } }
  const fetched = await mysqlDialect.runSelect(conn, 'SELECT fields', [], 10, (rows, bytes, limit, row) => ({ rows: [...rows, row], bytes, truncated: false }))
  assert.deepEqual(fetched.binaryColumns, [1, 2, 4, 5])
  assert.deepEqual(fetched.rows[0], ['[BLOB 4 bytes]', '中文 abcd', '0xff00', '{"id":9007199254740993}', '0b00000101', '{"x":1,"y":2}'])
  assert.equal(formatMysqlValue(Buffer.alloc(0), fields[1]), '')
  assert.equal(formatMysqlValue(Buffer.from('a\0b'), fields[1]), '0x610062')
  assert.equal(isBinaryCell(fetched, 0, fetched.rows[0][0]), false)
  assert.equal(isBinaryCell(fetched, 1, fetched.rows[0][1]), true)
  const result = { ...fetched, elapsedMs: 1, batch: [{ ...fetched, elapsedMs: 1 }] }
  assert.deepEqual(clipResultPreview(result).binaryColumns, fetched.binaryColumns)
  assert.deepEqual(clipResultPreview(result).batch[0].binaryColumns, fetched.binaryColumns)
  assert.deepEqual(JSON.parse(exportResult(result, 'json')).rows, fetched.rows)
  assert.ok(exportResult(result, 'csv').includes('中文 abcd'))
  assert.ok(exportResult(result, 'csv').includes('0xff00'))
  const statementConnection = { promise: () => ({ query: async () => [[values], fields] }) }
  assert.deepEqual((await mysqlDialect.executeShow(statementConnection, 'SHOW fields')).rows, fetched.rows)
  await assert.rejects(mysqlDialect.executeShow({ promise: () => ({ query: async () => [[[Buffer.alloc(600_000)]], [fields[1]]] }) }, 'SHOW large'), /1 MiB/)
  assert.equal(isBinaryCell({ columns: ['old'] }, 0, '[BLOB 4 bytes]'), true)
})

test('Host grid maintenance rejects binary text writes independently of client flags', () => {
  const metadata = { columns: [{ name: 'id', type: 'INT', key: 'PRI' }, { name: 'data', type: 'BLOB' }] }
  for (const kind of ['insert', 'update']) assert.throws(() => createDmlPlan('mysql', 'app', 'records', { kind, values: { data: '中文' }, original: { id: '1' } }, metadata), /二进制/)
})

test('actual SQL Worker survives mysql2 idle socket loss and Host revive keeps the generation', async t => {
  // Controlled protocol server: real mysql2 sockets and production Worker, no database.
  const server = mysql.createServer(), sockets = [], protocolErrors = []
  server.on('connection', conn => {
    sockets.push(conn)
    conn.on('error', error => protocolErrors.push(error.message))
    conn.serverHandshake({ protocolVersion: 10, serverVersion: '8.0.0-controlled', connectionId: sockets.length,
      statusFlags: 2, characterSet: 45, capabilityFlags: 0x8208,
      authCallback(_auth, done) { done(null); conn.sequenceId = 0 } })
    const respond = sql => {
      conn.sequenceId = 1
      const names = /SELECT VERSION\(\)/i.test(sql) ? ['version', 'db'] : /information_schema.schemata/i.test(sql) ? ['name'] : ['value']
      if (/^SELECT/i.test(sql)) {
        conn.writeColumns(names.map(name => ({ name, catalog: 'def', schema: 'app', table: '', orgTable: '', orgName: name, columnType: 253, characterSet: 45, columnLength: 100, flags: 0, decimals: 0 })))
        conn.writeTextRow(names.length === 2 ? ['8.0.0-controlled', 'app'] : [names[0] === 'name' ? 'app' : '1'])
        conn.writeEof()
      }
      else conn.writeOk()
      conn.sequenceId = 0
    }
    conn.on('query', respond)
    conn.on('stmt_prepare', respond)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const directory = temporaryDirectory(t, 'mysql-idle-worker-'), service = new ConnectionService(() => true, directory)
  t.after(async () => { await service.dispose(); for (const conn of sockets) conn.destroy(); await new Promise(resolve => server.close(resolve)) })
  const opened = await service.open('owner', connectionInput({ host: '127.0.0.1', port: server._server.address().port, database: 'app' }), false).catch(error => { throw new Error(error.message + '; controlled server: ' + protocolErrors.join('; ')) })
  const until = async check => { const deadline = Date.now() + 5000; while (!check()) { assert.ok(Date.now() < deadline, 'controlled MySQL deadline'); await delay(10) } }
  await until(() => sockets.length >= 2)
  await delay(50)
  sockets[1].stream.end()
  await delay(50)
  assert.equal(service.list('owner')[0].health, 'ready', 'query-only idle loss does not degrade login')
  sockets[0].stream.end()
  await until(() => service.list('owner')[0]?.health === 'degraded')
  await until(() => service.list('owner')[0]?.health === 'ready')
  assert.equal(service.list('owner')[0].generation, opened.generation)
  const fetched = await service.request('owner', opened.id, opened.generation, 'manual-query', { schema: 'app', sql: 'SELECT 1' })
  assert.deepEqual(fetched.rows, [['1']]); assert.deepEqual(fetched.binaryColumns, [])
})

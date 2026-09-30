import test from 'node:test'
import assert from 'node:assert/strict'
import { SchemaCache } from '../src/client/schema/schema-cache.ts'
import { completionOptionFingerprint, completionOptionsFromCache, completionRefreshAction, createSqlCompletionSource, ensureCompletionMetadata, shouldRefreshEditorCompletions } from '../src/client/sql/completion/source.ts'

test('completion source loads tables once then suggests FROM tables from cache', async () => {
  let tableCalls = 0, detailCalls = 0
  const catalog = async (_connection, input) => {
    if (input.kind === 'tables') {
      tableCalls += 1
      return { items: [{ name: 'user', kind: 'BASE TABLE' }, { name: 'orders', kind: 'BASE TABLE' }], more: false, collectedAt: '', source: 'test' }
    }
    detailCalls += 1
    await new Promise(resolve => setTimeout(resolve, 5))
    return { columns: [{ name: 'id', type: 'bigint' }, { name: 'name', type: 'varchar' }], collectedAt: '', source: 'test', primaryKeys: ['id'] }
  }
  const cache = new SchemaCache(catalog)
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  const live = { dialect: 'mysql', schema: 'biz', connection, cache }
  const sql = 'SELECT * FROM '
  ensureCompletionMetadata(live, sql)
  assert.equal(completionOptionsFromCache(live, sql, sql.length, '', false), null)
  await cache.loadTables(connection, 'biz')
  const options = completionOptionsFromCache(live, sql, sql.length, '', false)
  assert.ok(options?.some(item => item.label === 'user'))
  assert.ok(options?.some(item => item.label === 'orders'))
  ensureCompletionMetadata(live, 'SELECT u. FROM user u')
  await cache.loadTable(connection, 'biz', 'user')
  const dotted = 'SELECT u. FROM user u'
  const pos = dotted.indexOf('.') + 1
  const columns = completionOptionsFromCache(live, dotted, pos, '', false)
  assert.ok(columns?.some(item => item.label === 'id'))
  assert.equal(tableCalls, 1)
  assert.equal(detailCalls, 1)
  assert.equal(shouldRefreshEditorCompletions(live, sql, sql.length, true), true)
  assert.equal(shouldRefreshEditorCompletions(live, sql, sql.length, false), false)
})

function fakeContext(sql, pos, { explicit = false, aborted = false } = {}) {
  return {
    state: { doc: { toString: () => sql } },
    pos,
    explicit,
    aborted,
    matchBefore(regex) {
      const prefix = sql.slice(0, pos)
      const match = prefix.match(regex)
      if (!match) return null
      return { from: pos - match[0].length, to: pos, text: match[0] }
    },
  }
}

test('explicit completion waits for pending columns', async () => {
  const catalog = async (_connection, input) => {
    if (input.kind === 'tables') return { items: [{ name: 'user', kind: 'BASE TABLE' }], more: false, collectedAt: '', source: 'test' }
    await new Promise(resolve => setTimeout(resolve, 20))
    return { columns: [{ name: 'id', type: 'bigint' }], collectedAt: '', source: 'test', primaryKeys: ['id'] }
  }
  const cache = new SchemaCache(catalog, { emitCoalesceMs: 0, schedule: task => task() })
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  await cache.loadTables(connection, 'biz')
  const live = { dialect: 'mysql', schema: 'biz', connection, cache }
  const sql = 'SELECT \nFROM user'
  const source = createSqlCompletionSource(() => live)
  const result = await source(fakeContext(sql, 'SELECT '.length, { explicit: true }))
  assert.ok(result?.options.some(item => item.label === 'id'))
})

test('automatic completion never waits for metadata', async () => {
  let release
  const catalog = async (_connection, input) => {
    if (input.kind === 'tables') return { items: [{ name: 'user', kind: 'BASE TABLE' }], more: false, collectedAt: '', source: 'test' }
    await new Promise(resolve => { release = resolve })
    return { columns: [{ name: 'id', type: 'bigint' }], collectedAt: '', source: 'test', primaryKeys: ['id'] }
  }
  const cache = new SchemaCache(catalog, { emitCoalesceMs: 0, schedule: task => task() })
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  await cache.loadTables(connection, 'biz')
  const live = { dialect: 'mysql', schema: 'biz', connection, cache }
  const sql = 'SELECT d\nFROM user'
  const source = createSqlCompletionSource(() => live)
  const started = Date.now()
  const result = await source(fakeContext(sql, 'SELECT d'.length, { explicit: false }))
  assert.ok(Date.now() - started < 50)
  assert.ok(!result?.options.some(item => item.type === 'property'))
  assert.notEqual(result?.options[0]?.label, '正在加载列…')
  assert.equal(result?.options.at(-1)?.label, '正在加载列…')
  release?.()
})

test('aborted completion context returns null', async () => {
  const catalog = async (_connection, input) => {
    if (input.kind === 'tables') return { items: [{ name: 'user', kind: 'BASE TABLE' }], more: false, collectedAt: '', source: 'test' }
    await new Promise(resolve => setTimeout(resolve, 10))
    return { columns: [{ name: 'id', type: 'bigint' }], collectedAt: '', source: 'test', primaryKeys: ['id'] }
  }
  const cache = new SchemaCache(catalog, { emitCoalesceMs: 0, schedule: task => task() })
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  await cache.loadTables(connection, 'biz')
  const live = { dialect: 'mysql', schema: 'biz', connection, cache }
  const sql = 'SELECT \nFROM user'
  const source = createSqlCompletionSource(() => live)
  const result = await source(fakeContext(sql, 'SELECT '.length, { explicit: true, aborted: true }))
  assert.equal(result, null)
})

test('warm cache serves completions without catalog calls', async () => {
  let calls = 0
  const catalog = async (_connection, input) => {
    calls += 1
    if (input.kind === 'tables') return { items: [{ name: 'user', kind: 'BASE TABLE' }], more: false, collectedAt: '', source: 'test' }
    return { columns: [{ name: 'id', type: 'bigint' }], collectedAt: '', source: 'test', primaryKeys: ['id'] }
  }
  const cache = new SchemaCache(catalog, { emitCoalesceMs: 0, schedule: task => task() })
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  await cache.loadTables(connection, 'biz')
  await cache.loadTable(connection, 'biz', 'user')
  calls = 0
  const live = { dialect: 'mysql', schema: 'biz', connection, cache }
  const sql = 'SELECT \nFROM user'
  const options = completionOptionsFromCache(live, sql, 'SELECT '.length, 'i', false)
  assert.ok(options?.some(item => item.label === 'id'))
  assert.equal(calls, 0)
})

test('completion options rank closer fuzzy matches first', async () => {
  const catalog = async (_connection, input) => {
    if (input.kind === 'tables') {
      return { items: [{ name: 'user_status', kind: 'BASE TABLE' }, { name: 'user', kind: 'BASE TABLE' }, { name: 'orders', kind: 'BASE TABLE' }], more: false, collectedAt: '', source: 'test' }
    }
    return { columns: [], collectedAt: '', source: 'test', primaryKeys: [] }
  }
  const cache = new SchemaCache(catalog, { emitCoalesceMs: 0, schedule: task => task() })
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  await cache.loadTables(connection, 'biz')
  const live = { dialect: 'mysql', schema: 'biz', connection, cache }
  const sql = 'SELECT * FROM usr'
  const options = completionOptionsFromCache(live, sql, sql.length, 'usr', false)
  assert.equal(options?.[0]?.label, 'user')
  assert.ok(options?.some(item => item.label === 'user_status'))
})

test('open completion does not refresh when the option fingerprint is unchanged', async () => {
  const catalog = async (_connection, input) => {
    if (input.kind === 'tables') return { items: [{ name: 'user', kind: 'BASE TABLE' }, { name: 'orders', kind: 'BASE TABLE' }], more: false, collectedAt: '', source: 'test' }
    return { columns: [{ name: 'id', type: 'bigint' }], collectedAt: '', source: 'test', primaryKeys: ['id'] }
  }
  const cache = new SchemaCache(catalog, { emitCoalesceMs: 0, schedule: task => task() })
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  await cache.loadTables(connection, 'biz')
  const live = { dialect: 'mysql', schema: 'biz', connection, cache }
  const sql = 'SELECT * FROM '
  const seen = { tables: 2, intoColumns: '' }
  const fingerprint = completionOptionFingerprint(live, sql, sql.length)
  assert.equal(completionOptionFingerprint(live, sql, sql.length), fingerprint)
  const same = completionRefreshAction({ focused: true, live, sql, pos: sql.length, status: 'active', openFingerprint: fingerprint, seen })
  assert.equal(same.action, 'skip')
  const changed = completionRefreshAction({ focused: true, live, sql, pos: sql.length, status: 'pending', openFingerprint: fingerprint + '\nextra', seen })
  assert.equal(changed.action, 'start')
  const blurred = completionRefreshAction({ focused: false, live, sql, pos: sql.length, status: 'active', openFingerprint: 'different', seen })
  assert.equal(blurred.action, 'skip')
})

test('closed completion opens only when the table list or INSERT columns first arrive', async () => {
  let release
  const catalog = async (_connection, input) => {
    if (input.kind === 'tables') return { items: [{ name: 'user', kind: 'BASE TABLE' }], more: false, collectedAt: '', source: 'test' }
    await new Promise(resolve => { release = resolve })
    return { columns: [{ name: 'id', type: 'bigint' }], collectedAt: '', source: 'test', primaryKeys: ['id'] }
  }
  const cache = new SchemaCache(catalog, { emitCoalesceMs: 0, schedule: task => task() })
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  const live = { dialect: 'mysql', schema: 'biz', connection, cache }
  const fromSql = 'SELECT * FROM '
  const waiting = completionRefreshAction({ focused: true, live, sql: fromSql, pos: fromSql.length, status: null, openFingerprint: '', seen: { tables: -1, intoColumns: '' } })
  assert.equal(waiting.action, 'skip')
  assert.equal(waiting.seen.tables, 0)
  await cache.loadTables(connection, 'biz')
  const arrived = completionRefreshAction({ focused: true, live, sql: fromSql, pos: fromSql.length, status: null, openFingerprint: '', seen: waiting.seen })
  assert.equal(arrived.action, 'start')
  const again = completionRefreshAction({ focused: true, live, sql: fromSql, pos: fromSql.length, status: null, openFingerprint: '', seen: arrived.seen })
  assert.equal(again.action, 'skip')
  const insertSql = 'INSERT INTO user ('
  const loading = cache.loadTable(connection, 'biz', 'user')
  const beforeColumns = completionRefreshAction({ focused: true, live, sql: insertSql, pos: insertSql.length, status: null, openFingerprint: '', seen: { tables: 1, intoColumns: '' } })
  assert.equal(beforeColumns.action, 'skip')
  release?.()
  await loading
  const columns = completionRefreshAction({ focused: true, live, sql: insertSql, pos: insertSql.length, status: null, openFingerprint: '', seen: beforeColumns.seen })
  assert.equal(columns.action, 'start')
  const columnsAgain = completionRefreshAction({ focused: true, live, sql: insertSql, pos: insertSql.length, status: null, openFingerprint: '', seen: columns.seen })
  assert.equal(columnsAgain.action, 'skip')
})

// 方向键、回车和输入法组合态依赖 EditorView 的 keymap / composing，这里测不到。
test('repeated completion queries keep the same option fingerprint', async () => {
  const catalog = async (_connection, input) => {
    if (input.kind === 'tables') return { items: [{ name: 'user', kind: 'BASE TABLE' }], more: false, collectedAt: '', source: 'test' }
    return { columns: [{ name: 'id', type: 'bigint' }], collectedAt: '', source: 'test', primaryKeys: ['id'] }
  }
  const cache = new SchemaCache(catalog, { emitCoalesceMs: 0, schedule: task => task() })
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  await cache.loadTables(connection, 'biz')
  await cache.loadTable(connection, 'biz', 'user')
  const live = { dialect: 'mysql', schema: 'biz', connection, cache }
  const sql = 'SELECT i\nFROM user'
  const first = completionOptionFingerprint(live, sql, 'SELECT i'.length)
  const second = completionOptionFingerprint(live, sql, 'SELECT i'.length)
  assert.equal(first, second)
  assert.ok(first.includes('id'))
})

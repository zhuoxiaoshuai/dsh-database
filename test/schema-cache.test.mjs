import test from 'node:test'
import assert from 'node:assert/strict'
import { SchemaCache } from '../src/client/schema/schema-cache.ts'

function abortError() {
  return Object.assign(new Error('signal is aborted without reason'), { name: 'AbortError' })
}

function waitUntilAborted(signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    signal?.addEventListener('abort', () => reject(abortError()), { once: true })
  })
}

test('quiet table load does not publish a loading state', async () => {
  let release
  const catalog = async () => {
    await new Promise(resolve => { release = resolve })
    return { items: [{ name: 'user', kind: 'BASE TABLE' }], more: false, collectedAt: '', source: 'test' }
  }
  const cache = new SchemaCache(catalog)
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  const seen = []
  cache.subscribe(() => seen.push(cache.tablesStatus(connection, 'biz')?.status))
  const pending = cache.loadTables(connection, 'biz', { quiet: true })
  await Promise.resolve()
  assert.deepEqual(seen, [])
  release()
  await pending
  assert.deepEqual(seen, ['ready'])
})

test('schema cache pages tables and reuses details without extra catalog calls', async () => {
  let tableCalls = 0, detailCalls = 0
  const catalog = async (_connection, input) => {
    if (input.kind === 'tables') {
      tableCalls += 1
      if (input.offset) return { items: [{ name: 'orders', kind: 'BASE TABLE' }], more: false, collectedAt: '', source: 'test' }
      return { items: [{ name: 'user', kind: 'BASE TABLE' }], more: true, collectedAt: '', source: 'test' }
    }
    detailCalls += 1
    return { columns: [{ name: 'id', key: 'PRI', type: 'bigint' }], collectedAt: '', source: 'test', primaryKeys: ['id'] }
  }
  const cache = new SchemaCache(catalog)
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  const tables = await cache.loadTables(connection, 'biz')
  assert.deepEqual(tables.map(item => item.name), ['user', 'orders'])
  assert.equal(tableCalls, 2)
  await cache.loadTable(connection, 'biz', 'user')
  await cache.loadTable(connection, 'biz', 'user')
  assert.equal(detailCalls, 1)
  assert.deepEqual(cache.detailSnapshot(connection, 'biz', 'user')?.primaryKeys, ['id'])
})

test('late refresh responses cannot replace a newer epoch', async () => {
  let release
  let calls = 0
  const catalog = async (_connection, input) => {
    calls += 1
    const n = calls
    if (n === 1) await new Promise(resolve => { release = resolve })
    return { items: [{ name: n === 1 ? 'stale' : 'fresh', kind: 'BASE TABLE' }], more: false, collectedAt: '', source: 'test' }
  }
  const cache = new SchemaCache(catalog)
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  const first = cache.loadTables(connection, 'biz')
  const second = cache.loadTables(connection, 'biz', { refresh: true })
  release?.()
  await Promise.allSettled([first, second])
  assert.equal(cache.tablesSnapshot(connection, 'biz')?.[0]?.name, 'fresh')
})

test('error state backs off before retrying catalog', async () => {
  let now = 1000, detailCalls = 0
  const catalog = async () => {
    detailCalls += 1
    throw new Error('down')
  }
  const cache = new SchemaCache(catalog, { now: () => now, errorBackoffMs: 50 })
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  await assert.rejects(cache.loadTable(connection, 'biz', 'user'), /down/)
  await assert.rejects(cache.loadTable(connection, 'biz', 'user'), /down/)
  assert.equal(detailCalls, 1)
  now = 1060
  await assert.rejects(cache.loadTable(connection, 'biz', 'user'), /down/)
  assert.equal(detailCalls, 2)
})

test('prefetchColumns shares in-flight work and honors concurrency', async () => {
  let inflight = 0, max = 0, started = 0
  const catalog = async (_connection, input) => {
    if (input.kind === 'tables') return { items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }, { name: 'e' }], more: false, collectedAt: '', source: 'test' }
    started += 1
    inflight += 1
    max = Math.max(max, inflight)
    await new Promise(resolve => setTimeout(resolve, 20))
    inflight -= 1
    return { columns: [{ name: 'id' }], collectedAt: '', source: 'test', primaryKeys: ['id'] }
  }
  const cache = new SchemaCache(catalog, { prefetchConcurrency: 2 })
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  await cache.loadTables(connection, 'biz')
  cache.prefetchColumns(connection, 'biz', ['a', 'b', 'c', 'd', 'a'])
  cache.prefetchColumns(connection, 'biz', ['b', 'e'])
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.ok(max <= 2)
  assert.equal(started, 5)
  assert.ok(cache.detailSnapshot(connection, 'biz', 'e'))
})

test('schemas and schema info load lazily and reuse cache', async () => {
  const calls = []
  const catalog = async (_connection, input) => {
    calls.push(input.kind)
    if (input.kind === 'schemas') {
      const all = [{ name: 'biz' }, { name: 'sys' }]
      return { items: input.offset ? [] : all, more: false, collectedAt: '', source: 'test' }
    }
    if (input.kind === 'schema') return { collectedAt: '', source: 'test', summary: { objects: 3, dataBytes: 10 } }
    throw new Error(`unexpected ${input.kind}`)
  }
  const cache = new SchemaCache(catalog)
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  const schemas = await cache.loadSchemas(connection)
  assert.deepEqual(schemas.map(item => item.name), ['biz', 'sys'])
  await cache.loadSchemas(connection)
  const info = await cache.loadSchemaInfo(connection, 'biz')
  await cache.loadSchemaInfo(connection, 'biz')
  assert.equal(info.summary.objects, 3)
  assert.deepEqual(calls, ['schemas', 'schema'])
  assert.equal(cache.tablesSnapshot(connection, 'biz'), undefined)
})

test('generation change drops stale schema entries', async () => {
  const catalog = async () => ({ items: [{ name: 'user', kind: 'BASE TABLE' }], more: false, collectedAt: '', source: 'test' })
  const cache = new SchemaCache(catalog)
  const first = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  const second = { ...first, generation: 'g2' }
  await cache.loadTables(first, 'biz')
  await cache.loadTables(second, 'biz')
  assert.equal(cache.tablesSnapshot(first, 'biz'), undefined)
  assert.equal(cache.tablesSnapshot(second, 'biz')?.[0]?.name, 'user')
})

test('aborted table load rolls back and does not store an error', async () => {
  const controller = new AbortController()
  const catalog = async (_connection, _input, signal) => {
    await waitUntilAborted(signal)
    return { items: [{ name: 'late', kind: 'BASE TABLE' }], more: false, collectedAt: '', source: 'test' }
  }
  const cache = new SchemaCache(catalog)
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  const pending = cache.loadTables(connection, 'biz', { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending)
  assert.equal(cache.tablesSnapshot(connection, 'biz'), undefined)
  assert.notEqual(cache.tablesStatus(connection, 'biz')?.status, 'error')
})

test('a later catalog load retries after the previous request was aborted', async () => {
  let calls = 0
  const catalog = async (_connection, _input, signal) => {
    calls += 1
    if (calls === 1) await waitUntilAborted(signal)
    return { items: [{ name: 'app' }], more: false, collectedAt: '', source: 'test' }
  }
  const cache = new SchemaCache(catalog)
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  const first = new AbortController()
  const pending = cache.loadSchemas(connection, { signal: first.signal })
  await Promise.resolve()
  const second = cache.loadSchemas(connection)
  first.abort()
  await assert.rejects(pending)
  assert.deepEqual((await second).map(row => row.name), ['app'])
  assert.notEqual(cache.schemasStatus(connection)?.status, 'error')
})

test('invalidateConnection only drops one connection catalog', async () => {
  const catalog = async () => ({ items: [{ name: 'user', kind: 'BASE TABLE' }], more: false, collectedAt: '', source: 'test' })
  const cache = new SchemaCache(catalog)
  const first = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  const second = { id: 'c2', generation: 'g1', dialect: 'mysql', name: 'n2', environment: 'sit', database: 'biz', version: '8' }
  await cache.loadTables(first, 'biz')
  await cache.loadTables(second, 'biz')
  cache.invalidateConnection(first)
  assert.equal(cache.tablesSnapshot(first, 'biz'), undefined)
  assert.equal(cache.tablesSnapshot(second, 'biz')?.[0]?.name, 'user')
})

test('index loads keep a newer epoch', async () => {
  let release
  let calls = 0
  const catalog = async (_connection, input) => {
    if (input.kind !== 'indexes') return { columns: [{ name: 'id' }], collectedAt: '', source: 'test', primaryKeys: ['id'] }
    calls += 1
    const n = calls
    if (n === 1) await new Promise(resolve => { release = resolve })
    return { indexes: { status: 'actual', values: [{ INDEX_NAME: n === 1 ? 'old_idx' : 'new_idx', COLUMN_NAME: 'id' }] }, collectedAt: '', source: 'test' }
  }
  const cache = new SchemaCache(catalog)
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  await cache.loadTable(connection, 'biz', 'user')
  const first = cache.loadIndexes(connection, 'biz', 'user')
  const second = cache.loadIndexes(connection, 'biz', 'user', { refresh: true })
  release?.()
  await Promise.allSettled([first, second])
  const names = (cache.detailSnapshot(connection, 'biz', 'user')?.indexes)?.values?.map(row => row.INDEX_NAME)
  assert.deepEqual(names, ['new_idx'])
})

test('prewarmSchema warms columns up to the configured limit', async () => {
  let detailCalls = 0
  const catalog = async (_connection, input) => {
    if (input.kind === 'tables') {
      return {
        items: [
          { name: 'v1', kind: 'VIEW' }, { name: 'a', kind: 'BASE TABLE' }, { name: 'b', kind: 'BASE TABLE' },
          { name: 'c', kind: 'BASE TABLE' }, { name: 'd', kind: 'BASE TABLE' }, { name: 'e', kind: 'BASE TABLE' },
          { name: 'f', kind: 'BASE TABLE' }, { name: 'v2', kind: 'VIEW' },
        ],
        more: false, collectedAt: '', source: 'test',
      }
    }
    detailCalls += 1
    return { columns: [{ name: 'id' }], collectedAt: '', source: 'test', primaryKeys: ['id'] }
  }
  const cache = new SchemaCache(catalog, { prewarmTableLimit: 3, prefetchConcurrency: 2, emitCoalesceMs: 0, schedule: task => task() })
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  cache.prewarmSchema(connection, 'biz')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(detailCalls, 3)
  assert.ok(cache.detailSnapshot(connection, 'biz', 'a'))
  assert.ok(cache.detailSnapshot(connection, 'biz', 'b'))
  assert.ok(cache.detailSnapshot(connection, 'biz', 'c'))
  assert.equal(cache.detailSnapshot(connection, 'biz', 'v1'), undefined)
})

test('on-demand prefetch runs before background prewarm', async () => {
  const finished = []
  const catalog = async (_connection, input) => {
    if (input.kind === 'tables') {
      return { items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'z' }], more: false, collectedAt: '', source: 'test' }
    }
    await new Promise(resolve => setTimeout(resolve, 15))
    finished.push(input.table)
    return { columns: [{ name: 'id' }], collectedAt: '', source: 'test', primaryKeys: ['id'] }
  }
  const cache = new SchemaCache(catalog, { prefetchConcurrency: 1, emitCoalesceMs: 0, schedule: task => task() })
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  await cache.loadTables(connection, 'biz')
  cache.prewarmSchema(connection, 'biz')
  cache.prefetchColumns(connection, 'biz', ['z'])
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.ok(finished.includes('z'))
  assert.notEqual(finished.at(-1), 'z')
})

test('batched updates coalesce listener notifications', async () => {
  let emits = 0
  const catalog = async (_connection, input) => {
    if (input.kind === 'tables') return { items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }, { name: 'e' }], more: false, collectedAt: '', source: 'test' }
    await new Promise(resolve => setTimeout(resolve, 5))
    return { columns: [{ name: 'id' }], collectedAt: '', source: 'test', primaryKeys: ['id'] }
  }
  const cache = new SchemaCache(catalog, { prefetchConcurrency: 5, emitCoalesceMs: 30, schedule: task => task() })
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  await cache.loadTables(connection, 'biz')
  cache.subscribe(() => { emits += 1 })
  cache.prefetchColumns(connection, 'biz', ['a', 'b', 'c', 'd', 'e'])
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.ok(emits < 5)
  assert.ok(emits >= 1)
})

test('readiness reports prewarm progress', async () => {
  const catalog = async (_connection, input) => {
    if (input.kind === 'tables') return { items: [{ name: 'a' }, { name: 'b' }], more: false, collectedAt: '', source: 'test' }
    return { columns: [{ name: 'id' }], collectedAt: '', source: 'test', primaryKeys: ['id'] }
  }
  const cache = new SchemaCache(catalog, { emitCoalesceMs: 0, schedule: task => task() })
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  assert.equal(cache.readiness(connection, 'biz').tables, 'unknown')
  cache.prewarmSchema(connection, 'biz')
  await new Promise(resolve => setTimeout(resolve, 40))
  const ready = cache.readiness(connection, 'biz')
  assert.equal(ready.tables, 'ready')
  assert.equal(ready.columnsReady, 2)
  assert.equal(ready.columnsTotal, 2)
  assert.equal(ready.prewarmComplete, true)
})


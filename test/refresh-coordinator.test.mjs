import test from 'node:test'
import assert from 'node:assert/strict'
import { SchemaCache } from '../src/client/schema/schema-cache.ts'
import { blendLiveConnection, mergeSessionConnections, mergeWorkspaceConnections, refreshCatalogLayer } from '../src/client/schema/refresh.ts'

test('refresh keeps the previous snapshot until replacement succeeds', async () => {
  let calls = 0
  let release
  const catalog = async () => {
    calls += 1
    if (calls === 1) return { items: [{ name: 'old' }], more: false, collectedAt: '', source: 'test' }
    await new Promise(resolve => { release = resolve })
    return { items: [{ name: 'fresh' }], more: false, collectedAt: '', source: 'test' }
  }
  const cache = new SchemaCache(catalog)
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'biz', version: '8' }
  await cache.loadSchemas(connection)
  const pending = cache.loadSchemas(connection, { refresh: true })
  assert.equal(cache.schemasSnapshot(connection)?.[0]?.name, 'old')
  release?.()
  await pending
  assert.equal(cache.schemasSnapshot(connection)?.[0]?.name, 'fresh')
})

test('layered refresh does not invalidate sibling connections or deeper layers', async () => {
  const calls = []
  const catalog = async (_connection, input) => {
    calls.push(`${_connection.id}:${input.kind}:${input.schema || ''}:${input.table || ''}`)
    if (input.kind === 'schemas') return { items: [{ name: 'app' }], more: false, collectedAt: '', source: 'test' }
    if (input.kind === 'tables') return { items: [{ name: 'orders', kind: 'BASE TABLE' }], more: false, collectedAt: '', source: 'test' }
    return { columns: [{ name: 'id' }], collectedAt: '', source: 'test', primaryKeys: ['id'] }
  }
  const cache = new SchemaCache(catalog)
  const first = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'app', version: '8', live: true }
  const second = { id: 'c2', generation: 'g1', dialect: 'mysql', name: 'n2', environment: 'sit', database: 'app', version: '8', live: true }
  await cache.loadSchemas(first)
  await cache.loadTables(first, 'app')
  await cache.loadTable(first, 'app', 'orders')
  await cache.loadTables(second, 'app')
  calls.length = 0
  await refreshCatalogLayer(cache, first, { layer: 'connection' })
  assert.deepEqual(calls, ['c1:schemas::'])
  assert.equal(cache.tablesSnapshot(first, 'app')?.[0]?.name, 'orders')
  assert.equal(cache.detailSnapshot(first, 'app', 'orders')?.columns?.[0]?.name, 'id')
  assert.equal(cache.tablesSnapshot(second, 'app')?.[0]?.name, 'orders')
  calls.length = 0
  await refreshCatalogLayer(cache, first, { layer: 'database', schema: 'app' })
  assert.deepEqual(calls, ['c1:tables:app:'])
  assert.ok(cache.detailSnapshot(first, 'app', 'orders'))
})

test('workspace merge keeps unchanged connection object identity', () => {
  const first = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'app', version: '8', live: true, workbench: { schema: 'app' } }
  const listed = [{ ...first }, { id: 'c2', generation: 'g1', dialect: 'mysql', name: 'other', environment: 'sit', database: 'app', version: '8', live: false }]
  const merged = mergeWorkspaceConnections([first], listed)
  assert.equal(merged[0], first)
  assert.equal(merged[1].id, 'c2')
})

test('blend keeps local visibleSchemas when live snapshot omits them', () => {
  const previous = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'app', version: '8', live: false, workbench: { schema: 'app', visibleSchemas: ['app', 'hr'] } }
  const next = { id: 'c1', generation: 'g2', dialect: 'mysql', name: 'n', environment: 'sit', database: 'app', version: '8.4', live: true, workbench: { schema: 'app' } }
  const blended = blendLiveConnection(previous, next)
  assert.equal(blended.live, true)
  assert.equal(blended.generation, 'g2')
  assert.deepEqual(blended.workbench?.visibleSchemas, ['app', 'hr'])
})

test('blend keeps a cleared visibleSchemas list instead of restoring the server filter', () => {
  const previous = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'app', version: '8', live: true, workbench: { schema: 'app', visibleSchemas: [] } }
  const fresh = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'app', version: '8', live: true, workbench: { schema: 'app', visibleSchemas: ['app'] } }
  const merged = mergeWorkspaceConnections([previous], [fresh])
  assert.deepEqual(merged[0].workbench?.visibleSchemas, [])
})

test('session merge replaces query tabs and keeps the visible schema filter', () => {
  const previous = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'app', version: '8', live: true, workbench: { schema: 'app', queryTabs: [{ id: 'a', name: 'A', sql: 'SELECT a' }], visibleSchemas: ['app'] } }
  const next = { id: 'c1', generation: 'g1', dialect: 'mysql', name: 'n', environment: 'sit', database: 'app', version: '8', live: true, workbench: { schema: 'hr', visibleSchemas: ['app'] } }
  const merged = mergeSessionConnections([previous], [next])
  assert.equal(merged[0].workbench?.queryTabs, undefined)
  assert.equal(merged[0].workbench?.schema, 'hr')
  assert.deepEqual(merged[0].workbench?.visibleSchemas, ['app'])
  assert.equal(merged[0].id, 'c1')
})

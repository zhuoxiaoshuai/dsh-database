import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SchemaCache } from '../src/client/schema/schema-cache.ts'
import { treeFocusKey } from '../src/client/tree-focus.ts'

test('tables cache reuses catalog after the first load', async () => {
  let tableCalls = 0
  const catalog = async (_connection, input) => {
    if (input.kind === 'schemas') return { items: [{ name: 'app' }], more: false, collectedAt: '', source: 'test' }
    if (input.kind === 'tables') {
      tableCalls += 1
      return { items: [{ name: 'orders', kind: 'BASE TABLE' }], more: false, collectedAt: '', source: 'test' }
    }
    throw new Error(`unexpected ${input.kind}`)
  }
  const cache = new SchemaCache(catalog)
  const connection = { id: 'c1', generation: 'g1', dialect: 'mysql', name: '订单库', environment: 'sit', database: 'app', version: '8', live: true }
  await cache.loadSchemas(connection)
  await cache.loadTables(connection, 'app')
  await cache.loadTables(connection, 'app')
  assert.equal(tableCalls, 1)
  assert.equal(cache.tablesSnapshot(connection, 'app')?.[0]?.name, 'orders')
})

test('switching schema focus keys do not keep the previous table', () => {
  assert.equal(treeFocusKey({ kind: 'table', schema: 'old', table: 'users', objectKind: 'table' }), 'table:old:users')
  assert.equal(treeFocusKey({ kind: 'schema', schema: 'new' }), 'schema:new')
})

test('expanded connection sidebar reserves a separate gutter track', () => {
  const css = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8')
  assert.match(css, /\.db-object-sidebar:not\(\.is-collapsed\)\{display:grid;grid-template-columns:minmax\(0,1fr\) 14px/)
  assert.match(css, /\.db-object-sidebar:not\(\.is-collapsed\)>\.db-pane-gutter-x\{position:relative;/)
})

test('connection more menu includes copy', () => {
  const source = readFileSync(new URL('../src/client/workspace/shell/connection-tree-branch.tsx', import.meta.url), 'utf8')
  const workbench = readFileSync(new URL('../src/client/workspace/shell/workbench-shell.tsx', import.meta.url), 'utf8')
  assert.match(source, /复制连接/)
  assert.doesNotMatch(source, />刷新<\/button>/)
  assert.match(workbench, /const \[connectionMenu, setConnectionMenu\]/)
  assert.match(source, /onOpenOverflow/)
  assert.doesNotMatch(source, /useState<\{ x: number; y: number \}>/)
})

test('Kafka catalog roots sit on the connection tree, not in the overview switcher', () => {
  const kafka = readFileSync(new URL('../src/client/data-sources/kafka.tsx', import.meta.url), 'utf8')
  const branch = readFileSync(new URL('../src/client/workspace/shell/connection-tree-branch.tsx', import.meta.url), 'utf8')
  const workbench = readFileSync(new URL('../src/client/workspace/shell/workbench-shell.tsx', import.meta.url), 'utf8')
  const overview = readFileSync(new URL('../src/client/kafka/overview.tsx', import.meta.url), 'utf8')
  const descriptor = readFileSync(new URL('../src/shared/data-sources/kafka.ts', import.meta.url), 'utf8')
  assert.match(descriptor, /showsSchemaTree: false/)
  assert.match(kafka, /filterNoun: '分类'/)
  assert.match(kafka, /roots: \[\{ id: 'topics', label: 'Topics' \}, \{ id: 'groups', label: '消费组' \}\]/)
  assert.match(branch, /tree\?\.nodes\?\.\(item\) \?\? tree\?\.roots/)
  assert.match(branch, /CatalogRootNode/)
  assert.match(branch, /!showsSchemaTree \|\| !item\.live \|\| !open/)
  assert.match(branch, /visibleCatalogChildren/)
  assert.match(branch, /canFilterChildren &&/)
  assert.doesNotMatch(branch, /showsSchemaTree && <button/)
  assert.doesNotMatch(branch, /dialect === ['"]kafka['"]/)
  assert.doesNotMatch(branch, /dialect === ['"]redis['"]/)
  assert.match(workbench, /preferredCatalogRoot/)
  assert.match(workbench, /VisibleCatalogDialog/)
  assert.doesNotMatch(workbench, /filterRequest/)
  assert.match(workbench, /catalogRoot/)
  assert.match(overview, /catalog === 'groups' \? 'groups' : 'topics'/)
  assert.match(overview, /mode === 'groups'[\s\S]*groupsReplace\(\)/)
  assert.doesNotMatch(overview, /groupsLoaded|startGroups|db-search-tree-modes|setMode\(|aria-pressed/)
})

test('catalog child visibility is a connection menu, not a SQL-only dialog', () => {
  const redis = readFileSync(new URL('../src/client/data-sources/redis.tsx', import.meta.url), 'utf8')
  const pane = readFileSync(new URL('../src/client/active-connection-pane.tsx', import.meta.url), 'utf8')
  const actions = readFileSync(new URL('../src/client/tree-pane-actions.ts', import.meta.url), 'utf8')
  assert.match(redis, /filterNoun: '数据库'/)
  assert.doesNotMatch(pane, /VisibleSchemaDialog|VisibleCatalogDialog|filterRequest|openFilter/)
  assert.doesNotMatch(actions, /openFilter/)
})

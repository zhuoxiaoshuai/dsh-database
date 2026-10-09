import { emptyExecutionDocument, updateExecutionDocument, controlExecutionDocument } from '../src/shared/execution-document.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { catalogSchemaName, coerceVisibleSchemas, composeTableSelect, dedupeSqlTemplates, emptySharedQuery, isAbortError, keepResultOnFailure, preferredCatalogRoot, queryTabNeedsCloseConfirm, sanitizeConnectionWorkbench, schemaCatalogChildren, schemaNameListed, sharedQuerySurface, shouldMarkConnectionOffline, visibleCatalogChildren } from '../src/shared/workbench.ts'
import { catalogFilterCopy, sqlCatalogFilterCopy } from '../src/client/workspace/shell/catalog-filter-copy.ts'
import { catalogStatement } from '../src/host/catalog.mjs'

test('query tabs with drafts or results ask before close', () => {
  assert.equal(queryTabNeedsCloseConfirm({ id: '1', name: '查询 1', connectionId: 'c', sql: '' }), false)
  assert.equal(queryTabNeedsCloseConfirm({ id: '1', name: '查询 1', connectionId: 'c', sql: 'SELECT 1' }), true)
  assert.equal(queryTabNeedsCloseConfirm({
    id: '1', name: '查询 1', connectionId: 'c', sql: '',
    result: { columns: ['n'], rows: [['1']], truncated: false, elapsedMs: 1 },
  }), true)
})

test('sql templates dedupe by normalized whitespace and move to front', () => {
  const first = dedupeSqlTemplates([], 'SELECT  1')
  assert.deepEqual(first, ['SELECT  1'])
  const second = dedupeSqlTemplates(first, 'select 1')
  assert.equal(second.length, 2)
  const again = dedupeSqlTemplates(['SELECT 1', 'SELECT 2'], '  SELECT   1  ')
  assert.deepEqual(again, ['SELECT   1', 'SELECT 2'])
  assert.equal(dedupeSqlTemplates(['a'], '   ').length, 1)
})

test('unknown maintenance and closed connections keep prior results', () => {
  assert.equal(keepResultOnFailure('维护超时，结果未知；连接已关闭。请重新连接并核验实际状态，不要直接重试。'), true)
  assert.equal(keepResultOnFailure('连接已变化或不属于当前对话，请刷新。'), true)
  assert.equal(keepResultOnFailure('语法错误'), false)
  assert.equal(keepResultOnFailure('连接正在处理请求，请稍后再试。', 'connection_busy'), false)
  assert.equal(shouldMarkConnectionOffline('connection_offline', 'anything'), true)
  assert.equal(shouldMarkConnectionOffline('connection_closed', '连接已关闭。'), true)
  assert.equal(shouldMarkConnectionOffline('connection_stale', '连接已变化或当前对话已失效，请刷新。'), false)
  assert.equal(shouldMarkConnectionOffline('session_invalid', '当前对话已失效。'), false)
  assert.equal(shouldMarkConnectionOffline(undefined, '连接已变化或不属于当前对话，请刷新。'), false)
  assert.equal(shouldMarkConnectionOffline(undefined, '请先连接数据库。'), true)
  assert.equal(shouldMarkConnectionOffline('connection_busy', '连接正在处理请求，请稍后再试。'), false)
  assert.equal(shouldMarkConnectionOffline('request_cancelled', 'signal is aborted without reason'), false)
  assert.equal(shouldMarkConnectionOffline(undefined, 'signal is aborted without reason'), false)
  assert.equal(isAbortError(Object.assign(new Error('signal is aborted without reason'), { name: 'AbortError' })), true)
})

test('workbench snapshots drop result grids and cap sql drafts', () => {
  const saved = sanitizeConnectionWorkbench({
    schema: 'app',
    view: 'query',
    queryTabs: [{ id: 'tab-1', name: '草稿', sql: 'SELECT 1', result: { rows: [['secret']] } }],
    templates: ['SELECT 1', 'SELECT 1'],
    history: ['SELECT 2'],
  })
  assert.equal(saved.queryTabs?.[0].sql, 'SELECT 1')
  assert.equal(Object.hasOwn(saved.queryTabs?.[0] || {}, 'result'), false)
  assert.deepEqual(saved.templates, ['SELECT 1', 'SELECT 1'])
  const collab = sanitizeConnectionWorkbench({
    aiCollab: { sql: 'SELECT name FROM hotels', lastRun: { columns: ['name'], rowCount: 1, truncated: false, elapsedMs: 3, at: '2026-09-17', rows: [['secret']] } },
  })
  assert.equal(collab.sharedQuery?.sql, 'SELECT name FROM hotels')
  assert.equal(collab.sharedQuery?.controller, 'ai')
  assert.equal(collab.sharedQuery?.lastRun?.rowCount, 1)
  assert.equal(Object.hasOwn(collab.sharedQuery?.lastRun || {}, 'rows'), false)
  assert.equal(Object.hasOwn(collab, 'aiCollab'), false)
})

test('document edits take control and reject stale AI writes', () => {
  const start = emptyExecutionDocument('mysql')
  const user = updateExecutionDocument(start, 'SELECT 1', 'user', start.revision)
  assert.equal(user.controller, 'user'); assert.equal(user.revision, 2)
  assert.throws(() => updateExecutionDocument(user, 'SELECT 2', 'ai', user.revision), /用户已接管/)
  const returned = controlExecutionDocument(user, 'ai')
  const written = updateExecutionDocument(returned, 'SELECT 3', 'ai', returned.revision)
  assert.equal(written.text, 'SELECT 3')
  assert.throws(() => updateExecutionDocument(written, 'SELECT 4', 'ai', returned.revision), /已变化/)
})

test('sharedQuerySurface treats count/exists probes as verify unless purpose=result', () => {
  assert.equal(sharedQuerySurface('SELECT id, note FROM records'), 'result')
  assert.equal(sharedQuerySurface('SELECT COUNT(*) FROM records'), 'verify')
  assert.equal(sharedQuerySurface('SELECT COUNT(1) FROM records'), 'verify')
  assert.equal(sharedQuerySurface('SELECT EXISTS(SELECT 1 FROM records)'), 'verify')
  assert.equal(sharedQuerySurface('SELECT 1'), 'verify')
  assert.equal(sharedQuerySurface('SELECT COUNT(*) FROM records', 'result'), 'result')
  assert.equal(sharedQuerySurface('SELECT id FROM records', 'verify'), 'verify')
})

test('coerceVisibleSchemas rejects malformed values used by the schema filter UI', () => {
  assert.deepEqual(coerceVisibleSchemas([' app ', 'hr', 'app']), ['app', 'hr'])
  assert.deepEqual(coerceVisibleSchemas(null), [])
  assert.deepEqual(coerceVisibleSchemas({ bad: true }), [])
})

test('catalogSchemaName reads common catalog row shapes', () => {
  assert.equal(catalogSchemaName({ name: 'APP' }), 'APP')
  assert.equal(catalogSchemaName({ NAME: 'HR' }), 'HR')
  assert.equal(catalogSchemaName({ schema: 'demo' }), 'demo')
  assert.equal(catalogSchemaName({}), '')
})

test('session workbench drops visibleSchemas; coerce keeps a valid filter', () => {
  const saved = sanitizeConnectionWorkbench({ visibleSchemas: ['app', 'hr'], schema: 'app' })
  assert.equal(Object.hasOwn(saved, 'visibleSchemas'), false)
  assert.equal(saved.schema, 'app')
  assert.deepEqual(coerceVisibleSchemas(['app', 'hr']), ['app', 'hr'])
  const mixed = coerceVisibleSchemas(['app', 1, '', null, '  ', 'hr'])
  assert.deepEqual(mixed, ['app', 'hr'])
})

test('empty visibleSchemas means show all', () => {
  const saved = sanitizeConnectionWorkbench({ visibleSchemas: [] })
  assert.equal(Object.hasOwn(saved, 'visibleSchemas'), false)
  assert.deepEqual(coerceVisibleSchemas([]), [])
  assert.deepEqual(coerceVisibleSchemas([42, {}, 'app']), ['app'])
})

test('coerceVisibleSchemas truncates names and caps the list', () => {
  const longName = 'x'.repeat(200)
  const saved = coerceVisibleSchemas([longName, ...Array.from({ length: 210 }, (_, i) => `db${i}`)])
  assert.equal(saved.length, 200)
  assert.equal(saved[0].length, 128)
  assert.equal(saved[1], 'db0')
  assert.equal(saved[199], 'db198')
})

test('workbench snapshots without visibleSchemas stay unchanged', () => {
  const saved = sanitizeConnectionWorkbench({ schema: 'app' })
  assert.equal(Object.hasOwn(saved, 'visibleSchemas'), false)
  assert.equal(saved.schema, 'app')
})

test('visible catalog children show all when the list is empty', () => {
  const children = [{ id: '0', label: 'db0' }, { id: '1', label: 'db1' }, { id: 'topics', label: 'Topics' }]
  assert.deepEqual(visibleCatalogChildren(children, []).map(item => item.id), ['0', '1', 'topics'])
  assert.deepEqual(visibleCatalogChildren(children, null).map(item => item.id), ['0', '1', 'topics'])
})

test('visible catalog children filter by id and always keep the current child', () => {
  const children = [{ id: '0', label: 'db0' }, { id: '1', label: 'db1' }, { id: 'topics', label: 'Topics' }]
  assert.deepEqual(visibleCatalogChildren(children, ['1'], { currentId: '0' }).map(item => item.id), ['0', '1'])
  assert.deepEqual(visibleCatalogChildren(children, ['topics']).map(item => item.id), ['topics'])
})

test('catalog search matches labels and still keeps the current child', () => {
  const children = [{ id: '0', label: 'db0' }, { id: '1', label: 'db1' }, { id: 'topics', label: 'Topics' }]
  assert.deepEqual(visibleCatalogChildren(children, [], { currentId: '0', search: 'topic' }).map(item => item.id), ['0', 'topics'])
})

test('visible catalog children can ignore id case', () => {
  const schemas = [{ id: 'HR', label: 'HR' }, { id: 'APP', label: 'APP' }]
  assert.deepEqual(visibleCatalogChildren(schemas, ['hr'], { caseInsensitive: true }).map(item => item.id), ['HR'])
  assert.deepEqual(visibleCatalogChildren(schemas, ['hr'], { currentId: 'app', caseInsensitive: true }).map(item => item.id), ['HR', 'APP'])
})

test('preferred catalog root keeps a listed current id, otherwise the first visible child', () => {
  const roots = [{ id: 'topics', label: 'Topics' }, { id: 'groups', label: '消费组' }]
  assert.equal(preferredCatalogRoot(roots, 'topics', ['groups']), 'topics')
  assert.equal(preferredCatalogRoot(roots, '', ['groups']), 'groups')
  assert.equal(preferredCatalogRoot(roots, 'missing', ['groups']), 'groups')
  assert.equal(preferredCatalogRoot([{ id: '0', label: 'db0' }, { id: '1', label: 'db1' }], '', undefined), '0')
})

test('schema catalog children dedupe and sort for the filter dialog', () => {
  assert.deepEqual(schemaCatalogChildren([{ NAME: 'hr' }, { name: 'app' }, { name: 'hr' }, {}]), [
    { id: 'app', label: 'app' },
    { id: 'hr', label: 'hr' },
  ])
})

test('sql catalog filter copy stays the existing database wording', () => {
  assert.equal(sqlCatalogFilterCopy.title, '显示的数据库')
  assert.equal(sqlCatalogFilterCopy.hint, '勾选要在对象树中显示的数据库；不勾选任何库时显示全部，当前打开的库始终显示。')
  assert.equal(sqlCatalogFilterCopy.emptyList, '连接在线并加载对象树后，才能选择要显示的数据库。')
  assert.equal(sqlCatalogFilterCopy.emptyTree, '没有可见的数据库')
  const kafka = catalogFilterCopy('分类')
  assert.equal(kafka.title, '显示的分类')
  assert.match(kafka.hint, /不勾选任何项时显示全部，当前选中项始终显示/)
})

test('schemaNameListed matches Oracle names without case', () => {
  assert.equal(schemaNameListed(['HR', 'SCOTT'], 'hr', true), true)
  assert.equal(schemaNameListed(['HR'], 'SCOTT', true), false)
  assert.equal(schemaNameListed(['App'], 'app', false), false)
  assert.equal(schemaNameListed(['app'], 'app', false), true)
})

test('compose table data select with filter sort and page', () => {
  assert.equal(
    composeTableSelect('mysql', 'app', 'orders', { filter: "status = 'open'", sortField: 'id', sortOrder: 'DESC', page: 2 }),
    "SELECT * FROM `app`.`orders`\nWHERE status = 'open'\nORDER BY `id` DESC\nLIMIT 100 OFFSET 100",
  )
  assert.equal(
    composeTableSelect('oracle', 'APP', 'ORDERS', { page: 1 }),
    'SELECT * FROM "APP"."ORDERS"\nOFFSET 0 ROWS FETCH FIRST 100 ROWS ONLY',
  )
})

test('mysql schemas catalog uses SHOW DATABASES', () => {
  const sql = catalogStatement('mysql', { kind: 'schemas' }).sql
  assert.equal(sql, 'SHOW DATABASES')
  assert.doesNotMatch(sql, /information_schema/)
})

test('mysql tables catalog uses SHOW FULL TABLES for one schema', () => {
  const sql = catalogStatement('mysql', { kind: 'tables', schema: 'app' }).sql
  assert.match(sql, /SHOW FULL TABLES FROM `app`/)
  assert.doesNotMatch(sql, /information_schema/)
})

test('mysql table and index catalog use SHOW FULL COLUMNS / SHOW INDEX', () => {
  assert.match(catalogStatement('mysql', { kind: 'table', schema: 'app', table: 'orders' }).sql, /SHOW FULL COLUMNS FROM `app`\.`orders`/)
  assert.match(catalogStatement('mysql', { kind: 'indexes', schema: 'app', table: 'orders' }).sql, /SHOW INDEX FROM `app`\.`orders`/)
})


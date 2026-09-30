import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSqlExperience } from '../src/host/sql-template-normalizer.ts'
import { similarTemplates } from '../src/host/sql-template-similarity.ts'
import { SqlTemplateStore } from '../src/host/sql-template-store.ts'
import { temporaryDirectory } from './helpers.mjs'

function store(t) {
  const directory = temporaryDirectory(t, 'sql-templates-')
  const templates = new SqlTemplateStore(directory)
  return templates
}

const CONN_A = '11111111-1111-4111-8111-111111111111'
const CONN_B = '22222222-2222-4222-8222-222222222222'

test('constant and whitespace differences share a fingerprint', async () => {
  const a = await normalizeSqlExperience("SELECT id FROM orders WHERE status = 'paid'", 'mysql')
  const b = await normalizeSqlExperience("select  id  from  orders  where status = 'open'", 'mysql')
  assert.equal(a.features.parseOk, true)
  assert.equal(a.fingerprint, b.fingerprint)
  assert.match(a.normalizedSql, /:s/)
})

test('different tables are not treated as duplicates', async () => {
  const a = await normalizeSqlExperience('SELECT id FROM orders', 'mysql')
  const b = await normalizeSqlExperience('SELECT id FROM customers', 'mysql')
  assert.notEqual(a.fingerprint, b.fingerprint)
})

test('unparsed sql cannot auto-merge with a parsed template', async () => {
  const parsed = await normalizeSqlExperience('SELECT id FROM orders', 'mysql')
  const raw = await normalizeSqlExperience('not a statement !!!', 'mysql')
  assert.equal(raw.features.parseOk, false)
  const hits = similarTemplates(raw, [{
    id: 't1', familyId: 'f1', version: 1, title: '查询 orders', summary: '', tags: [],
    normalizedSql: parsed.normalizedSql, fingerprint: parsed.fingerprint, features: parsed.features,
    archived: false, usageCount: 0, updatedAt: new Date().toISOString(),
  }])
  assert.ok(!hits.some(hit => hit.score >= 0.5 && hit.reasons.every(reason => !/未解析/.test(reason))) || hits[0].score < 0.5)
})

const oracleCases = [
  ['SELECT DBMS_RANDOM.VALUE() FROM DUAL', { operation: 'select', risk: 'readonly', tables: [] }],
  ['SELECT * FROM OTHER.RECORDS', { operation: 'select', risk: 'readonly', tables: ['RECORDS'] }],
  ["SELECT id, NVL(note, 'empty') FROM RECORDS", { operation: 'select', risk: 'readonly', tables: ['RECORDS'], columns: ['ID', 'NOTE'] }],
  ['INSERT INTO RECORDS (id) VALUES (1)', { operation: 'insert', risk: 'dml', tables: ['RECORDS'], columns: ['ID'] }],
  ['UPDATE RECORDS SET id = 2 WHERE id = 1', { operation: 'update', risk: 'dml', tables: ['RECORDS'], columns: ['ID'], conditionColumns: ['ID'] }],
  ['DELETE FROM RECORDS WHERE id = 1', { operation: 'delete', risk: 'dml', tables: ['RECORDS'], conditionColumns: ['ID'] }],
  ["MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET t.v = s.v WHEN NOT MATCHED THEN INSERT (id, v) VALUES (s.id, s.v)", { operation: 'merge', risk: 'dml', tables: ['S', 'T'], columns: ['ID', 'V'] }],
]

test('Oracle templates parse SELECT/DML features without PostgreSQL fallback', async () => {
  const join = await normalizeSqlExperience(
    "SELECT c.id, COUNT(o.id) FROM customers c LEFT JOIN orders o ON c.id = o.customer_id WHERE c.status = 'open' GROUP BY c.id HAVING COUNT(o.id) > 1 ORDER BY c.id",
    'oracle',
  )
  assert.equal(join.features.parseOk, true)
  assert.equal(join.features.operation, 'select')
  assert.deepEqual(join.features.tables, ['CUSTOMERS', 'ORDERS'])
  assert.ok(join.features.columns.includes('ID'))
  assert.ok(join.features.columns.includes('STATUS'))
  assert.ok(join.features.conditionColumns.includes('STATUS'))
  assert.ok(join.features.joins.some(item => /LEFT/.test(item)))
  assert.deepEqual(join.features.aggregates, ['COUNT'])
  assert.deepEqual(join.features.groupBy, ['ID'])
  assert.deepEqual(join.features.orderBy, ['ID'])
  assert.equal(join.features.risk, 'readonly')

  for (const [sql, expect] of oracleCases) {
    const result = await normalizeSqlExperience(sql, 'oracle')
    assert.equal(result.features.parseOk, true, sql)
    assert.equal(result.features.operation, expect.operation, sql)
    assert.equal(result.features.risk, expect.risk, sql)
    if (expect.tables) assert.deepEqual(result.features.tables, expect.tables, sql)
    if (expect.columns) for (const column of expect.columns) assert.ok(result.features.columns.includes(column), `${sql} missing ${column}`)
    if (expect.conditionColumns) for (const column of expect.conditionColumns) assert.ok(result.features.conditionColumns.includes(column), `${sql} missing condition ${column}`)
  }
})

test('Oracle unquoted names share a fingerprint; quoted names keep their own identity', async () => {
  const a = await normalizeSqlExperience("SELECT id FROM orders WHERE status = 'paid'", 'oracle')
  const b = await normalizeSqlExperience("select  id  from  orders  where status = 'open'", 'oracle')
  const quoted = await normalizeSqlExperience('SELECT "ID" FROM "Orders" WHERE "Status" = :status FETCH FIRST 100 ROWS ONLY', 'oracle')
  const cte = await normalizeSqlExperience('WITH c AS (SELECT id FROM records) SELECT COUNT(id) FROM c', 'oracle')
  assert.equal(a.features.parseOk, true)
  assert.equal(a.fingerprint, b.fingerprint)
  assert.deepEqual(a.features.tables, ['ORDERS'])
  assert.equal(quoted.features.parseOk, true)
  assert.deepEqual(quoted.features.tables, ['Orders'])
  assert.notEqual(quoted.fingerprint, a.fingerprint)
  assert.equal(cte.features.operation, 'with')
  assert.deepEqual(cte.features.tables, ['RECORDS'])
  assert.deepEqual(cte.features.aggregates, ['COUNT'])
})

test('unreliable Oracle SQL stays unparsed and cannot auto-merge', async () => {
  const parsed = await normalizeSqlExperience('SELECT id FROM orders', 'oracle')
  const raw = await normalizeSqlExperience('CREATE TABLE T (ID NUMBER)', 'oracle')
  const junk = await normalizeSqlExperience('NOT A QUERY', 'oracle')
  assert.equal(raw.features.parseOk, false)
  assert.equal(junk.features.parseOk, false)
  const hits = similarTemplates(raw, [{
    id: 't1', familyId: 'f1', version: 1, title: '查询 orders', summary: '', tags: [],
    normalizedSql: parsed.normalizedSql, fingerprint: parsed.fingerprint, features: parsed.features,
    archived: false, usageCount: 0, updatedAt: new Date().toISOString(),
  }])
  assert.ok(!hits.some(hit => hit.score >= 0.5 && hit.reasons.every(reason => !/未解析/.test(reason))) || hits[0].score < 0.5)
})

test('Oracle template merge follows the same object set as query policy for readable DML', async () => {
  const { authorizeStatement } = await import('../src/host/query-policy.mjs')
  const readable = [
    'SELECT DBMS_RANDOM.VALUE() FROM DUAL',
    'SELECT * FROM OTHER.RECORDS',
    "SELECT id, NVL(note, 'empty') FROM RECORDS",
    'INSERT INTO RECORDS (id) VALUES (1)',
    'UPDATE RECORDS SET id = 2 WHERE id = 1',
  ]
  for (const sql of readable) {
    const policy = await authorizeStatement('oracle', sql, 'BUSINESS')
    const template = await normalizeSqlExperience(sql, 'oracle')
    assert.equal(template.features.parseOk, true, sql)
    assert.deepEqual([...template.features.tables].sort(), [...policy.tables].sort(), sql)
    assert.equal(template.features.risk, policy.kind === 'select' ? 'readonly' : 'dml', sql)
  }
  const paid = await normalizeSqlExperience("INSERT INTO orders (id, status) VALUES (1, 'paid')", 'oracle')
  const open = await normalizeSqlExperience("INSERT INTO orders (id, status) VALUES (2, 'open')", 'oracle')
  assert.equal(paid.fingerprint, open.fingerprint)
  const hits = similarTemplates(open, [{
    id: 't1', familyId: 'f1', version: 1, title: '新增 orders', summary: '', tags: [],
    normalizedSql: paid.normalizedSql, fingerprint: paid.fingerprint, features: paid.features,
    archived: false, usageCount: 0, updatedAt: new Date().toISOString(),
  }])
  assert.equal(hits[0]?.score, 1)
})

test('templates are isolated per connectionId', async t => {
  const templates = store(t)
  const sql = "SELECT id FROM orders WHERE status = 'paid'"
  const a = await templates.publish({ sql, dialect: 'mysql', connectionId: CONN_A, action: 'create', title: '连接 A' })
  const b = await templates.publish({ sql, dialect: 'mysql', connectionId: CONN_B, action: 'create', title: '连接 B' })
  assert.notEqual(a.id, b.id)
  assert.equal(templates.searchSummaries('', 'mysql', CONN_A).length, 1)
  assert.equal(templates.searchSummaries('', 'mysql', CONN_B).length, 1)
  assert.equal(templates.searchSummaries('', 'mysql', CONN_A)[0].title, '连接 A')
  assert.equal(templates.searchSummaries('', 'mysql', CONN_B)[0].title, '连接 B')
})

test('search summaries omit sql bodies and exact duplicate create merges', async t => {
  const templates = store(t)
  const first = await templates.publish({ sql: "SELECT id FROM orders WHERE status = 'paid'", dialect: 'mysql', connectionId: CONN_A, action: 'create', title: '查订单 A' })
  const summaries = templates.searchSummaries('订单', 'mysql', CONN_A)
  assert.ok(summaries.some(item => item.id === first.id))
  for (const item of summaries) {
    assert.equal(Object.hasOwn(item, 'originalSql'), false)
    assert.equal(Object.hasOwn(item, 'normalizedSql'), false)
  }
  const merged = await templates.publish({
    sql: "SELECT id FROM orders WHERE status = 'open'",
    dialect: 'mysql',
    connectionId: CONN_A,
    action: 'create',
    title: '查订单 B',
    summary: '按状态查订单',
    tags: ['orders'],
  })
  assert.equal(merged.id, first.id)
  assert.equal(templates.list().filter(item => !item.unpublished).length, 1)
  assert.match(merged.summary, /订单/)
  assert.ok(merged.tags.includes('orders'))
})

test('create without title fills suggested metadata from sql', async t => {
  const templates = store(t)
  const created = await templates.publish({
    sql: 'SELECT id, status FROM orders WHERE id = :id',
    dialect: 'mysql',
    connectionId: CONN_A,
    action: 'create',
  })
  assert.ok(created.title.trim())
  assert.ok(Array.isArray(created.tags))
  await templates.whenIdle()
  const item = templates.get(created.id)
  assert.ok(item.summary.trim())
  assert.match(item.title, /orders/i)
})

test('publish requires confirmation path and version conflicts are visible', async t => {
  const templates = store(t)
  const created = await templates.publish({ sql: 'SELECT id FROM orders WHERE id = 1', dialect: 'mysql', connectionId: CONN_A, action: 'create', title: '查订单' })
  const preview = await templates.preview('SELECT id FROM orders WHERE id = 2', 'mysql', CONN_A)
  assert.ok(preview.similar.some(hit => hit.id === created.id && hit.score >= 0.9))
  await assert.rejects(templates.publish({
    sql: 'SELECT id FROM orders WHERE id = 3', dialect: 'mysql', connectionId: CONN_A, action: 'newVersion',
    targetId: created.id, expectedVersion: created.version + 1, title: '查订单',
  }), /已被其他人更新/)
  const next = await templates.publish({
    sql: 'SELECT id, status FROM orders WHERE id = 3', dialect: 'mysql', connectionId: CONN_A, action: 'newVersion',
    targetId: created.id, expectedVersion: created.version, title: '查订单',
  })
  assert.equal(next.familyId, created.familyId)
  assert.equal(next.version, created.version + 1)
  assert.equal(templates.search('订单', 'mysql', CONN_A).length, 1)
  assert.equal(templates.list().filter(item => item.title.includes('订单')).length, 2)
  assert.ok(templates.get(created.id))
  assert.ok(templates.get(next.id))
  assert.doesNotMatch(JSON.stringify(templates.list()), /'paid'|secret/)
})

test('publishFromSql creates, merges near-duplicates, and requires connectionId', async t => {
  const templates = store(t)
  const sql = "SELECT id FROM orders WHERE status = 'paid'"
  const created = await templates.publishFromSql({ sql, dialect: 'mysql', connectionId: CONN_A, title: '查已支付订单' })
  assert.equal(created.merged, false)
  assert.equal(created.title, '查已支付订单')
  const item = templates.get(created.id, true)
  assert.ok(item)
  assert.equal(item.originalSql, sql)

  const merged = await templates.publishFromSql({
    sql: "SELECT id FROM orders WHERE status = 'open'",
    dialect: 'mysql',
    connectionId: CONN_A,
    title: '查订单（合并）',
    summary: '按状态筛选',
    tags: ['orders'],
  })
  assert.equal(merged.merged, true)
  assert.equal(merged.id, created.id)
  assert.equal(templates.list().filter(row => !row.unpublished && !row.archived).length, 1)
  const updated = templates.get(created.id, true)
  assert.equal(updated.title, '查订单（合并）')
  assert.match(updated.summary, /状态/)
  assert.ok(updated.tags.includes('orders'))

  assert.equal(templates.search('订单', 'mysql', CONN_A).length, 1)
  assert.equal(templates.search('订单', 'mysql', CONN_B).length, 0)

  await assert.rejects(templates.publishFromSql({
    sql: 'SELECT 1',
    dialect: 'mysql',
    connectionId: '',
    title: '无效',
  }), /connectionId/)
})

test('create persists before AST parse and enriches in the background', async t => {
  const templates = store(t)
  const created = await templates.publish({
    sql: 'SELECT id FROM orders WHERE id = 1',
    dialect: 'mysql',
    connectionId: CONN_A,
    action: 'create',
    title: '查订单',
  })
  assert.equal(created.features.parseOk, false)
  assert.equal(created.title, '查订单')
  await templates.whenIdle()
  const item = templates.get(created.id)
  assert.equal(item.features.parseOk, true)
  assert.ok(item.features.tables.includes('orders'))
  assert.match(item.summary, /orders/i)
})

test('archived templates disappear from search but remain in store', async t => {
  const templates = store(t)
  const created = await templates.publish({ sql: 'SELECT id FROM archive_me', dialect: 'mysql', connectionId: CONN_A, action: 'create', title: '待归档' })
  assert.ok(templates.searchSummaries('待归档', 'mysql', CONN_A).some(item => item.id === created.id))
  templates.archive(created.id)
  assert.equal(templates.searchSummaries('待归档', 'mysql', CONN_A).length, 0)
  const row = templates.list().find(item => item.id === created.id)
  assert.ok(row?.archived)
  await assert.rejects(templates.dispatch({ action: 'template-get', id: created.id }), /不存在|归档/)
})

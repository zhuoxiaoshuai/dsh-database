import { emptyExecutionDocument, updateExecutionDocument, controlExecutionDocument } from '../src/shared/execution-document.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { EXECUTION_STATUS_LABELS, executionChain, executionChainNewestFirst, executionConclusion, executionLocalDayLabel, executionOutcomeSummary, executionTitle, groupExecutionsByLocalDay, inferExecutionType, isTerminalStatus } from '../src/shared/execution.ts'
import { DATABASE_OPERATIONS } from '../src/shared/database-actions.ts'
import { emptySharedQuery } from '../src/shared/workbench.ts'
import { structureStatusLabel } from '../src/shared/structure-outcome.ts'

test('AI execution labels and terminal states match the plugin UI contract', () => {
  assert.equal(EXECUTION_STATUS_LABELS.running, '执行中')
  assert.equal(EXECUTION_STATUS_LABELS.awaiting_confirmation, '等待确认')
  assert.equal(isTerminalStatus('running'), false)
  assert.equal(isTerminalStatus('unknown'), true)
  assert.equal(structureStatusLabel('partial'), '部分失败')
})

test('execution titles fall back without exposing tool names as the only label', () => {
  assert.equal(executionTitle({ operation: 'database_search_tables', title: '查找 XIE_CHENG 中匹配“travel”的表，定位业务表' }), '查找 XIE_CHENG 中匹配“travel”的表，定位业务表')
  assert.equal(executionTitle({
    operation: 'database_search_tables',
    sql: 'SELECT t.TABLE_NAME AS name FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA=? AND (LOCATE(?,t.TABLE_NAME)>0 OR EXISTS(SELECT 1 FROM information_schema.COLUMNS c WHERE LOCATE(?,c.COLUMN_NAME)>0))\n-- params: ["XIE_CHENG","travel","travel"]',
  }), '查找 XIE_CHENG 中匹配“travel”的表，定位业务表')
  assert.equal(executionTitle({
    operation: 'database_search_tables',
    sql: 'SELECT t.TABLE_NAME AS name FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA=? ORDER BY t.TABLE_NAME\n-- params: ["XIE_CHENG"]',
  }), '查找 XIE_CHENG 中的表，确认有哪些业务表')
  assert.equal(executionTitle({ operation: 'database_search_tables' }), '查找表，定位可用业务表')
  assert.equal(executionTitle({ operation: 'database_describe_table', schema: 'app', tables: ['orders'] }), '查看 app.orders 的结构，确认字段后再写查询')
  assert.equal(executionConclusion({ status: 'failed', message: '语法错误' }), '语法错误')
  assert.equal(executionConclusion({ status: 'succeeded', resultMeta: { columns: ['id'], rowCount: 2, truncated: false, elapsedMs: 1 } }), '返回 2 行')
  assert.equal(executionOutcomeSummary({
    operation: 'database_search_tables', status: 'succeeded', conclusion: '找到 122 个表。',
  }), '查询成功，返回 122 张表，可继续查下一个库。')
  assert.equal(executionOutcomeSummary({
    operation: 'database_search_tables', status: 'succeeded', tables: ['a', 'b'],
  }), '查询成功，返回 2 张表，可继续查下一个库。')
})

test('every database operation has stable title and type metadata', () => {
  const expectedTitles = {
    database_list_connections: '列出已登录连接，为后续查库准备 connectionId',
    database_import_connections: '批量登记数据库连接，供稍后在工作台补密码登录',
    database_list_schemas: '列出数据库，确认可见库和表数量',
    database_search_tables: '查找表，定位可用业务表',
    database_describe_table: '查看表结构，确认字段后再写查询',
    database_query_readonly: '执行只读查询，取得当前数据',
    database_execute_sql: '执行 SQL，取得当前数据',
    database_explain_plan: '查看执行计划，诊断索引与扫描',
    database_search_templates: '检索 SQL 经验，复用已发布的查询写法',
    database_get_template: '读取 SQL 经验原文，仍须通过当前连接策略',
    database_save_template: '保存 SQL 经验到经验库',
    database_read_collab: '读取当前 AI Query，核对用户是否已改写或接管',
    database_status: '查看工作台状态',
    database_catalog: '列出数据库，确认可见库和表数量',
    database_templates: '检索 SQL 经验，复用已发布的查询写法',
    shared_query_write: '执行写 SQL',
    workbench_shared_query: '执行当前 SQL',
    redis_status: '查看 Redis 状态', redis_keys: '扫描 Redis Key', redis_value: '读取 Redis Key', redis_execute: '执行 Redis 命令',
  }
  const expectedTypes = {
    database_list_connections: 'catalog', database_import_connections: 'tool', database_list_schemas: 'catalog',
    database_search_tables: 'catalog', database_describe_table: 'catalog', database_query_readonly: 'query', database_execute_sql: 'query',
    database_explain_plan: 'explain', database_search_templates: 'tool', database_get_template: 'tool',
    database_save_template: 'tool', database_read_collab: 'tool', database_status: 'tool',
    database_catalog: 'catalog', database_templates: 'tool',
    shared_query_write: 'write', workbench_shared_query: 'query',
    redis_status: 'tool', redis_keys: 'catalog', redis_value: 'tool', redis_execute: 'tool',
  }
  assert.deepEqual(Object.keys(expectedTitles), [...DATABASE_OPERATIONS])
  for (const operation of DATABASE_OPERATIONS) {
    assert.equal(executionTitle({ operation }), expectedTitles[operation])
    assert.equal(inferExecutionType(operation), expectedTypes[operation])
  }
  assert.equal(executionTitle({ operation: 'future_operation' }), '数据库操作')
  assert.equal(inferExecutionType('future_operation'), 'tool')
})

test('execution history groups by local calendar day and keeps newest first inside each day', () => {
  const now = new Date('2026-09-17T12:00:00')
  const item = (executionId, createdAt, updatedAt) => ({
    executionId, createdAt, updatedAt, operation: 'database_query_readonly', status: 'succeeded',
    conversationId: 'c', callId: executionId, rootCallId: executionId, tables: [], resultPersisted: false, events: [], revision: 1,
  })
  const groups = groupExecutionsByLocalDay([
    item('a', '2026-09-17T08:00:00.000Z', '2026-09-17T09:00:00.000Z'),
    item('b', '2026-09-17T02:00:00.000Z', '2026-09-17T10:00:00.000Z'),
    item('c', '2026-09-16T10:00:00.000Z', '2026-09-16T11:00:00.000Z'),
  ])
  assert.equal(groups.length, 2)
  assert.equal(executionLocalDayLabel(groups[0].dayKey, now), '今天')
  assert.deepEqual(groups[0].items.map(row => row.executionId), ['b', 'a'])
  assert.equal(executionLocalDayLabel(groups[1].dayKey, now), '昨天')
  assert.deepEqual(groups[1].items.map(row => row.executionId), ['c'])
})

test('one AI round is ordered by createdAt for the same rootCallId', () => {
  const items = [
    { executionId: 'b', rootCallId: 'root', callId: '2', createdAt: '2026-09-17T02:00:00.000Z', operation: 'database_search_tables', status: 'succeeded', conversationId: 'c', tables: [], resultPersisted: false, updatedAt: '', events: [], revision: 1 },
    { executionId: 'a', rootCallId: 'root', callId: '1', createdAt: '2026-09-17T01:00:00.000Z', operation: 'database_list_schemas', status: 'succeeded', conversationId: 'c', tables: [], resultPersisted: false, updatedAt: '', events: [], revision: 1 },
    { executionId: 'c', rootCallId: 'other', callId: '3', createdAt: '2026-09-16T03:00:00.000Z', operation: 'database_query_readonly', status: 'succeeded', conversationId: 'c', tables: [], resultPersisted: false, updatedAt: '', events: [], revision: 1 },
  ]
  const chain = executionChain(items, items[0])
  assert.deepEqual(chain.map(item => item.executionId), ['a', 'b'])
  assert.deepEqual(executionChain(items).map(item => item.executionId), ['a', 'b'])
})

test('execution chain stays on the same rootCallId and does not collapse a whole day', () => {
  const items = [
    { executionId: 'a', callId: 'a', rootCallId: 'a', createdAt: '2026-09-17T01:00:00.000Z', updatedAt: '', operation: 'database_list_schemas', status: 'succeeded', conversationId: 'c', connectionId: 'conn', tables: [], resultPersisted: false, events: [], revision: 1 },
    { executionId: 'b', callId: 'b', rootCallId: 'b', createdAt: '2026-09-17T01:05:00.000Z', updatedAt: '', operation: 'database_search_tables', status: 'succeeded', conversationId: 'c', connectionId: 'conn', tables: [], resultPersisted: false, events: [], revision: 1 },
    { executionId: 'c', callId: 'c', rootCallId: 'c', createdAt: '2026-09-17T01:10:00.000Z', updatedAt: '', operation: 'database_search_tables', status: 'succeeded', conversationId: 'c', connectionId: 'conn', tables: [], resultPersisted: false, events: [], revision: 1 },
  ]
  assert.deepEqual(executionChain(items, items[1]).map(item => item.executionId), ['b'])
})

test('step chain display puts newest execution first without changing executionChain order', () => {
  const chain = [
    { executionId: 'a', createdAt: '2026-09-17T01:00:00.000Z', operation: 'database_list_schemas', status: 'succeeded', conversationId: 'c', callId: 'a', rootCallId: 'a', tables: [], resultPersisted: false, updatedAt: '', events: [], revision: 1 },
    { executionId: 'b', createdAt: '2026-09-17T02:00:00.000Z', operation: 'database_search_tables', status: 'succeeded', conversationId: 'c', callId: 'b', rootCallId: 'b', tables: [], resultPersisted: false, updatedAt: '', events: [], revision: 1 },
  ]
  assert.deepEqual(executionChainNewestFirst(chain).map(item => item.executionId), ['b', 'a'])
})

test('writing sql from execution detail takes user control of shared query', () => {
  const start = emptyExecutionDocument('mysql')
  const next = updateExecutionDocument(start, 'SELECT 1', 'user', start.revision, { schema: 'app' })
  assert.equal(next.controller, 'user')
  assert.equal(next.text, 'SELECT 1')
  assert.throws(() => updateExecutionDocument(next, 'SELECT 2', 'ai', next.revision), /用户已接管/)
})

import { emptyExecutionDocument, updateExecutionDocument, controlExecutionDocument } from '../src/shared/execution-document.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyExecutionResult as applyResult, displayFromLatest as recoverResult, displayMatchingEditor as matchingEditor, keepHydratedDisplay as keepDisplay } from '../src/shared/query-sync.ts'
import { emptySharedQuery } from '../src/shared/workbench.ts'
import { inferExecutionType, isDisplayHistoryExecution, historyItemsForConnection } from '../src/shared/execution.ts'
import { isLegacyRedisHistoryExecution } from '../src/client/redis/history.ts'

// Existing behavior fixtures now include the execution identity required by production.
const identified = value => value && ({ generation: 'g1', schema: '', initiator: 'ai',
  documentText: (value.executedSql || '').replace(/^EXPLAIN\s+/i, ''), ...value })
const applyExecutionResult = (current, event, owner) => applyResult(identified(current), identified(event), { generation: 'g1', schema: '', ...owner })
const displayMatchingEditor = (value, sql) => matchingEditor(identified(value), sql)
const keepHydratedDisplay = (current, next, sql) => keepDisplay(identified(current), identified(next), sql)
const displayFromLatest = (id, query, latest, generation = 'g1') =>
  recoverResult(id, query, latest && { ...identified(latest), initiator: latest.initiator || query.controller }, generation)

const query = (overrides = {}) => ({ ...emptySharedQuery(), sql: 'SELECT A', revision: 2, controller: 'ai', ...overrides })

test('AI result cannot overwrite the current grid after user takeover', () => {
  const kept = applyExecutionResult(undefined, {
    type: 'EXECUTION_FINISHED', connectionId: 'a', executionId: 'e1', initiator: 'ai',
    queryRevision: 2, executedSql: 'SELECT A', result: { columns: ['id'], rows: [['1']], truncated: false, elapsedMs: 1 },
  }, { connectionId: 'a', controller: 'user', sql: 'SELECT B', queryRevision: 3 })
  assert.equal(kept, undefined)
})

test('matching finished execution becomes DisplayResult', () => {
  const shown = applyExecutionResult(undefined, {
    type: 'EXECUTION_FINISHED', connectionId: 'a', executionId: 'e1', initiator: 'ai',
    queryRevision: 2, executedSql: 'SELECT A', result: { columns: ['id'], rows: [['1']], truncated: false, elapsedMs: 1 },
  }, { connectionId: 'a', controller: 'ai', sql: 'SELECT A', queryRevision: 2 })
  assert.equal(shown?.executionId, 'e1')
  assert.equal(shown?.result.rows[0][0], '1')
})

test('FINISHED with an obsolete revision cannot replace the current result', () => {
  const shown = applyExecutionResult(undefined, {
    type: 'EXECUTION_FINISHED', connectionId: 'a', executionId: 'e1', initiator: 'ai',
    queryRevision: 18, executedSql: 'SELECT id FROM records', result: { columns: ['id'], rows: [['1']], truncated: false, elapsedMs: 1 },
  }, { connectionId: 'a', controller: 'ai', sql: 'SELECT id FROM records', queryRevision: 19 })
  assert.equal(shown, undefined)
})

test('AI explain result is kept when editor still has the inner SELECT', () => {
  const shown = applyExecutionResult(undefined, {
    type: 'EXECUTION_FINISHED', connectionId: 'a', executionId: 'e1', initiator: 'ai', kind: 'explain',
    queryRevision: 2, executedSql: 'EXPLAIN SELECT A', result: { columns: ['plan'], rows: [['idx']], truncated: false, elapsedMs: 1 },
  }, { connectionId: 'a', controller: 'ai', sql: 'SELECT A', queryRevision: 2 })
  assert.equal(shown?.kind, 'explain')
  assert.equal(shown?.result.rows[0][0], 'idx')
})

test('stale AI result is dropped when the editor already has a newer SQL', () => {
  const previous = {
    connectionId: 'a', executionId: 'e1', queryRevision: 2, executedSql: 'SELECT A', result: { columns: ['id'], rows: [['1']], truncated: false, elapsedMs: 1 },
  }
  const kept = applyExecutionResult(previous, {
    type: 'EXECUTION_FINISHED', connectionId: 'a', executionId: 'e1', initiator: 'ai',
    executedSql: 'SELECT A', result: previous.result,
  }, { connectionId: 'a', controller: 'ai', sql: 'SELECT B', queryRevision: 3 })
  assert.equal(kept, undefined)
})

test('QUERY_CHANGED away from executed SQL clears the previous grid', () => {
  const previous = {
    connectionId: 'a', executionId: 'e1', queryRevision: 2, executedSql: 'SELECT A', result: { columns: ['id'], rows: [['1']], truncated: false, elapsedMs: 1 },
  }
  assert.equal(displayMatchingEditor(previous, 'SELECT B'), undefined)
  assert.equal(displayMatchingEditor(previous, 'SELECT A')?.executionId, 'e1')
})

test('a clipped preview of the same run does not replace the live grid', () => {
  const wide = {
    columns: ['a', 'b'],
    rows: [['1', 'long'], ['2', 'long']],
    truncated: false,
    elapsedMs: 1,
  }
  const current = {
    connectionId: 'a', executionId: 'e1', queryRevision: 2, executedSql: 'SELECT A', result: wide,
  }
  const clipped = applyExecutionResult(current, {
    type: 'EXECUTION_FINISHED', connectionId: 'a', executionId: 'e1', initiator: 'ai',
    executedSql: 'SELECT A', result: { columns: ['a'], rows: [['1']], truncated: true, elapsedMs: 1 },
  }, { connectionId: 'a', controller: 'ai', sql: 'SELECT A', queryRevision: 2 })
  assert.equal(clipped?.result.columns.length, 2)
  assert.equal(clipped?.result.rows.length, 2)
  const hydrated = keepHydratedDisplay(current, {
    connectionId: 'a', executionId: 'e1', queryRevision: 2, executedSql: 'SELECT A',
    result: { columns: ['a'], rows: [['1']], truncated: true, elapsedMs: 1 },
  }, 'SELECT A')
  assert.equal(hydrated?.result.columns.length, 2)
})

test('hydrate does not replace a live grid with an empty latest', () => {
  const current = {
    connectionId: 'a', executionId: 'e1', queryRevision: 2, executedSql: 'SELECT A', result: { columns: ['id'], rows: [['1']], truncated: false, elapsedMs: 1 },
  }
  assert.equal(keepHydratedDisplay(current, undefined, 'SELECT A')?.executionId, 'e1')
  assert.equal(keepHydratedDisplay(current, undefined, 'SELECT B'), undefined)
})

test('failed execution uses the host error message', () => {
  const shown = applyExecutionResult(undefined, {
    type: 'EXECUTION_FAILED', connectionId: 'a', executionId: 'e2', initiator: 'ai', queryRevision: 2, executedSql: 'SELECT A', message: '语法错误',
  }, { connectionId: 'a', controller: 'ai', sql: 'SELECT A', queryRevision: 2 })
  assert.equal(shown?.result.message, '语法错误')
})

test('hydrate latest requires matching connection, sql for user control, and generation', () => {
  const shared = query({ sql: 'SELECT A', revision: 2 })
  assert.ok(displayFromLatest('a', shared, { executionId: 'e', connectionId: 'a', queryRevision: 2, executedSql: 'SELECT A', type: 'query', result: { columns: ['id'], rows: [['1']], truncated: false, elapsedMs: 1 } }))
  assert.equal(displayFromLatest('a', shared, { executionId: 'e', connectionId: 'a', queryRevision: 1, executedSql: 'SELECT A', type: 'query', result: { columns: ['id'], rows: [['1']], truncated: false, elapsedMs: 1 } }), undefined)
  assert.equal(displayFromLatest('a', shared, { executionId: 'e', connectionId: 'b', queryRevision: 2, executedSql: 'SELECT A', type: 'query', result: { columns: ['id'], rows: [['1']], truncated: false, elapsedMs: 1 } }), undefined)
  assert.equal(displayFromLatest('a', query({ controller: 'user', sql: 'SELECT B', revision: 3 }), { executionId: 'e', connectionId: 'a', queryRevision: 2, executedSql: 'SELECT A', type: 'query', result: { columns: ['id'], rows: [['1']], truncated: false, elapsedMs: 1 } }), undefined)
  assert.equal(displayFromLatest('a', shared, { executionId: 'e', connectionId: 'a', queryRevision: 2, executedSql: 'SELECT A', type: 'query', result: { columns: ['id'], rows: [['1']], truncated: false, elapsedMs: 1 }, generation: 'old' }, 'new'), undefined)
})

test('verify-like executions are not display history', () => {
  assert.equal(inferExecutionType('database_query_readonly', 'verify'), 'verify')
  assert.equal(inferExecutionType('database_execute_sql', 'verify'), 'verify')
  assert.equal(inferExecutionType('database_execute_sql'), 'query')
  assert.equal(isDisplayHistoryExecution({ type: 'verify', operation: 'database_query_readonly', status: 'succeeded' }), false)
  assert.equal(isDisplayHistoryExecution({ type: 'query', operation: 'database_query_readonly', status: 'succeeded' }), true)
})

test('Redis history lists AI ops only', () => {
  assert.equal(isLegacyRedisHistoryExecution({ operation: 'redis_execute', initiator: 'ai' }), true)
  assert.equal(isLegacyRedisHistoryExecution({ operation: 'redis_keys', initiator: 'ai' }), true)
  assert.equal(isLegacyRedisHistoryExecution({ operation: 'redis_value', initiator: 'ai' }), true)
  assert.equal(isLegacyRedisHistoryExecution({ operation: 'redis_execute' }), false)
  assert.equal(isLegacyRedisHistoryExecution({ operation: 'redis_execute', initiator: 'user' }), false)
  assert.equal(isLegacyRedisHistoryExecution({ operation: 'redis_keys', initiator: 'user' }), false)
  assert.equal(isLegacyRedisHistoryExecution({ operation: 'redis_value', initiator: 'user' }), false)
  assert.equal(isLegacyRedisHistoryExecution({ operation: 'redis_status', initiator: 'ai' }), false)
  const sql = { connectionId: 'sql', operation: 'database_execute_sql', type: 'query', status: 'succeeded' }
  const scan = { connectionId: 'redis', operation: 'redis_keys', initiator: 'user', type: 'tool', status: 'succeeded' }
  const command = { connectionId: 'redis', operation: 'redis_execute', initiator: 'user', type: 'tool', status: 'succeeded' }
  const aiCommand = { connectionId: 'redis', operation: 'redis_execute', initiator: 'ai', type: 'tool', status: 'succeeded' }
  const aiRead = { connectionId: 'redis', operation: 'redis_value', initiator: 'ai', type: 'tool', status: 'succeeded' }
  assert.deepEqual(historyItemsForConnection([sql, scan, command, aiCommand, aiRead], 'redis', isLegacyRedisHistoryExecution).map(item => item.operation), ['redis_execute', 'redis_value'])
  assert.deepEqual(historyItemsForConnection([sql, scan, command, aiCommand, aiRead], 'sql').map(item => item.operation), ['database_execute_sql'])
})

test('explicit takeover changes controller without requiring a SQL edit', () => {
  const next = controlExecutionDocument(emptyExecutionDocument('mysql'), 'user')
  assert.equal(next.controller, 'user')
  assert.equal(next.controllerReason, 'user-takeover')
  assert.equal(next.revision, 2)
})
test('legacy results without complete identity stay in history, not the current editor', () => {
  const latest = { executionId: 'legacy', connectionId: 'a', queryRevision: 2, executedSql: 'SELECT A',
    type: 'query', result: { columns: [], rows: [], truncated: false, elapsedMs: 1 } }
  assert.equal(recoverResult('a', query(), latest, 'g1'), undefined)
  assert.equal(applyResult(undefined, { ...latest, type: 'EXECUTION_FINISHED' },
    { connectionId: 'a', generation: 'g1', schema: '', controller: 'ai', sql: 'SELECT A', queryRevision: 2 }), undefined)
})

test('selection live and recovery use the full document, never substring ownership', () => {
  const owner = { connectionId: 'a', generation: 'g1', schema: 'app', controller: 'user', sql: 'SELECT 1; SELECT 2', queryRevision: 4 }
  const result = { columns: ['n'], rows: [['2']], truncated: false, elapsedMs: 1 }
  const execution = { executionId: 'selected', connectionId: 'a', generation: 'g1', schema: 'app', initiator: 'user',
    queryRevision: 4, executedSql: 'SELECT 2', documentText: owner.sql, result }
  const live = applyResult(undefined, { ...execution, type: 'EXECUTION_FINISHED' }, owner)
  const recovered = recoverResult('a', { sql: owner.sql, schema: owner.schema, revision: 4, controller: 'user' }, { ...execution, type: 'query' }, 'g1')
  assert.deepEqual(live, recovered)
  for (const patch of [{ documentText: 'SELECT 2' }, { schema: 'other' }, { generation: 'g2' }, { queryRevision: 5 }, { documentText: undefined }]) {
    assert.equal(applyResult(undefined, { ...execution, ...patch, type: 'EXECUTION_FAILED' }, owner), undefined)
    assert.equal(recoverResult('a', { sql: owner.sql, schema: owner.schema, revision: 4, controller: 'user' }, { ...execution, ...patch, type: 'query' }, 'g1'), undefined)
  }
})

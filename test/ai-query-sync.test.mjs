import test from 'node:test'
import assert from 'node:assert/strict'
import { applyExecutionResult, applyQueryChanged, displayFromLatest, displayMatchingEditor, hydrateSharedQuery, keepHydratedDisplay } from '../src/shared/query-sync.ts'
import { emptySharedQuery, takeSharedQueryControl } from '../src/shared/workbench.ts'
import { inferExecutionType, isDisplayHistoryExecution, historyItemsForConnection } from '../src/shared/execution.ts'
import { isLegacyRedisHistoryExecution } from '../src/client/redis/history.ts'

const query = (overrides = {}) => ({ ...emptySharedQuery(), sql: 'SELECT A', revision: 2, controller: 'ai', ...overrides })

test('QUERY_CHANGED applies newer revision for the current connection', () => {
  const next = applyQueryChanged(query(), {
    type: 'QUERY_CHANGED', connectionId: 'a', queryRevision: 3, sql: 'SELECT B', controller: 'ai',
  }, { connectionId: 'a' })
  assert.equal(next?.sql, 'SELECT B')
  assert.equal(next?.revision, 3)
})

test('QUERY_CHANGED ignores other connections and stale revisions', () => {
  assert.equal(applyQueryChanged(query(), {
    type: 'QUERY_CHANGED', connectionId: 'b', queryRevision: 9, sql: 'SELECT X', controller: 'ai',
  }, { connectionId: 'a' }), undefined)
  assert.equal(applyQueryChanged(query({ revision: 5 }), {
    type: 'QUERY_CHANGED', connectionId: 'a', queryRevision: 4, sql: 'SELECT OLD', controller: 'ai',
  }, { connectionId: 'a' }), undefined)
})

test('local user editing blocks AI QUERY_CHANGED', () => {
  const next = applyQueryChanged(query({ controller: 'user', sql: 'SELECT B', revision: 4 }), {
    type: 'QUERY_CHANGED', connectionId: 'a', queryRevision: 5, sql: 'SELECT A', controller: 'ai',
  }, { connectionId: 'a', localEditing: true })
  assert.equal(next, undefined)
})

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

test('FINISHED still displays when queryRevision drifted after authorize rewrite', () => {
  const shown = applyExecutionResult(undefined, {
    type: 'EXECUTION_FINISHED', connectionId: 'a', executionId: 'e1', initiator: 'ai',
    queryRevision: 18, executedSql: 'SELECT id FROM records', result: { columns: ['id'], rows: [['1']], truncated: false, elapsedMs: 1 },
  }, { connectionId: 'a', controller: 'ai', sql: 'SELECT id FROM records', queryRevision: 19 })
  assert.equal(shown?.executionId, 'e1')
  assert.equal(shown?.result.rows[0][0], '1')
})

test('AI explain result is kept when editor still has the inner SELECT', () => {
  const shown = applyExecutionResult(undefined, {
    type: 'EXECUTION_FINISHED', connectionId: 'a', executionId: 'e1', initiator: 'ai', kind: 'explain',
    executedSql: 'EXPLAIN SELECT A', result: { columns: ['plan'], rows: [['idx']], truncated: false, elapsedMs: 1 },
  }, { connectionId: 'a', controller: 'ai', sql: 'SELECT A', queryRevision: 2 })
  assert.equal(shown?.kind, 'explain')
  assert.equal(shown?.result.rows[0][0], 'idx')
})

test('QUERY_CHANGED merges schema', () => {
  const next = applyQueryChanged(query({ schema: 'old' }), {
    type: 'QUERY_CHANGED', connectionId: 'a', queryRevision: 3, sql: 'SELECT B', controller: 'ai', schema: 'app',
  }, { connectionId: 'a' })
  assert.equal(next?.schema, 'app')
})

test('hydrate keeps local SQL while the user is editing', () => {
  const local = query({ controller: 'user', sql: 'SELECT B', revision: 4 })
  const remote = query({ controller: 'ai', sql: 'SELECT A', revision: 9, schema: 'app' })
  const merged = hydrateSharedQuery(local, remote, { connectionId: 'a', localEditing: true })
  assert.equal(merged.sql, 'SELECT B')
  assert.equal(merged.revision, 4)
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
    type: 'EXECUTION_FAILED', connectionId: 'a', executionId: 'e2', initiator: 'ai', executedSql: 'SELECT A', message: '语法错误',
  }, { connectionId: 'a', controller: 'ai', sql: 'SELECT A', queryRevision: 2 })
  assert.equal(shown?.result.message, '语法错误')
})

test('hydrate latest requires matching connection, sql for user control, and generation', () => {
  const shared = query({ sql: 'SELECT A', revision: 2 })
  assert.ok(displayFromLatest('a', shared, { executionId: 'e', connectionId: 'a', queryRevision: 2, executedSql: 'SELECT A', type: 'query', result: { columns: ['id'], rows: [['1']], truncated: false, elapsedMs: 1 } }))
  assert.ok(displayFromLatest('a', shared, { executionId: 'e', connectionId: 'a', queryRevision: 1, executedSql: 'SELECT A', type: 'query', result: { columns: ['id'], rows: [['1']], truncated: false, elapsedMs: 1 } }))
  assert.equal(displayFromLatest('a', shared, { executionId: 'e', connectionId: 'b', queryRevision: 2, executedSql: 'SELECT A', type: 'query', result: { columns: ['id'], rows: [['1']], truncated: false, elapsedMs: 1 } }), undefined)
  assert.equal(displayFromLatest('a', query({ controller: 'user', sql: 'SELECT B', revision: 3 }), { executionId: 'e', connectionId: 'a', queryRevision: 2, executedSql: 'SELECT A', type: 'query', result: { columns: ['id'], rows: [['1']], truncated: false, elapsedMs: 1 } }), undefined)
  assert.equal(displayFromLatest('a', shared, { executionId: 'e', connectionId: 'a', queryRevision: 2, executedSql: 'SELECT A', type: 'query', result: { columns: ['id'], rows: [['1']], truncated: false, elapsedMs: 1 }, generation: 'old' }, 'new'), undefined)
})

test('CONTROL_CHANGED merges controller without requiring newer sql', () => {
  const next = applyQueryChanged(query(), {
    type: 'CONTROL_CHANGED', connectionId: 'a', queryRevision: 3, sql: 'SELECT A', controller: 'user',
  }, { connectionId: 'a' })
  assert.equal(next?.controller, 'user')
  assert.equal(next?.sql, 'SELECT A')
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
  const next = takeSharedQueryControl(emptySharedQuery())
  assert.equal(next.controller, 'user')
  assert.equal(next.controllerReason, 'user-takeover')
  assert.equal(next.revision, 2)
})

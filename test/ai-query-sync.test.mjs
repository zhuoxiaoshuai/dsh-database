import { emptyExecutionDocument, controlExecutionDocument } from '../src/shared/execution-document.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { inferExecutionType, isDisplayHistoryExecution, historyItemsForConnection } from '../src/shared/execution.ts'
import { isLegacyRedisHistoryExecution } from '../src/client/redis/history.ts'

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

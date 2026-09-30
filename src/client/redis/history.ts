import type { ExecutionRecord } from '../../shared/execution.ts'

/** Preserve visibility for records written before historyVisible was stored. */
export function isLegacyRedisHistoryExecution(record: Pick<ExecutionRecord, 'operation' | 'initiator'>): boolean {
  return record.initiator === 'ai' && (record.operation === 'redis_keys' || record.operation === 'redis_value' || record.operation === 'redis_execute')
}

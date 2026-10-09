import type { Connection, Result } from '../shared/workbench.ts'
import type { ExecutionType } from '../shared/execution.ts'
import { executionStop } from '../shared/execution.ts'
import { DEFAULT_QUERY_PAGE_SIZE } from '../shared/limits.ts'
import { sqlReceiptSteps } from '../shared/sql-receipts.ts'
import type { OperationBinding, OperationLifecycle, OperationMetadata, OperationStatus } from './operation-runtime.ts'

export function sqlOperationBinding(owner: string, connection: Connection): OperationBinding {
  return { owner, connectionId: connection.id, generation: connection.generation!, connectionName: connection.name,
    sourceId: connection.dialect, environment: connection.environment }
}

export function sqlOperationMetadata(input: {
  schema: string; sql: string; revision: number; initiator: 'ai' | 'user'; type: ExecutionType
  callId?: string; rootCallId?: string; explain?: boolean; documentText?: string
}): OperationMetadata {
  const { schema, sql, revision, initiator, type, callId, rootCallId, explain } = input
  return { schema, sql, executedSql: sql, documentText: input.documentText ?? sql, queryRevision: revision, initiator, type, callId, rootCallId, historyVisible: false,
    operation: explain ? 'database_explain_plan' : initiator === 'ai' ? 'database_execute_sql' : 'workbench_shared_query',
    ...(!explain ? { draft: { kind: 'query', sql, schema } } : {}),
    title: explain ? '查看执行计划，诊断索引与扫描' : initiator === 'ai'
      ? (type === 'verify' ? '验证查询' : `在 ${schema} 中执行查询，取得当前数据`) : '执行当前 SQL',
    reason: explain ? '为诊断索引与扫描方式。' : initiator === 'ai'
      ? '为在可见 AI Query 中取得当前数据。' : '用户在 AI Query 中执行当前 SQL。' }
}

export function sqlCompletion(result: Result, kind: string, explain = false) {
  const sets = Array.isArray(result.batch) && result.batch.length > 1 ? result.batch : [result]
  const message = sets.length > 1 ? `已执行 ${sets.length} 条` : result.message
  const conclusion = explain ? (result.message || '已采集执行计划。') : sets.length > 1 ? `已执行 ${sets.length} 条。`
    : kind === 'write' ? (result.message || `已提交 · 影响 ${result.affectedRows ?? 0} 行。`)
    : `返回 ${result.rows.length} 行${result.truncated ? '（已截断）' : ''}。`
  return { message, result, conclusion }
}

export function classifySqlInterruption(error: unknown, lifecycle: OperationLifecycle & { write?: boolean }): OperationStatus {
  const effect = (error as { effect?: string } | undefined)?.effect
  if (effect === 'unknown') return 'unknown'
  if (effect === 'none') return lifecycle.aborted && !lifecycle.dispatched ? 'cancelled' : 'failed'
  if (lifecycle.dispatched && lifecycle.write) return 'unknown'
  return executionStop({ ...lifecycle, message: error instanceof Error ? error.message : '执行失败' }).status
}

export function sqlFailureMessage(error: unknown, lifecycle: OperationLifecycle, status?: OperationStatus): string {
  if (status === 'unknown') return `执行结果未知，请核验，勿重复提交。${error instanceof Error ? error.message : ''}`
  return executionStop({ ...lifecycle, message: error instanceof Error ? error.message : '执行失败' }).message
}

export function sqlModel(result: Result, executionId: string, controlLost: boolean) {
  const sets = Array.isArray(result.batch) && result.batch.length > 1 ? result.batch : [result]
  const receipts = result.steps?.length ? sqlReceiptSteps(result) : undefined
  const statements = receipts ? receipts.map(step => ({ index: step.index, sql: step.sql, status: result.steps!.find(item => item.index === step.index)!.status,
    truncated: step.result?.truncated ?? false, elapsedMs: step.result?.elapsedMs ?? 0,
    columns: step.result?.columns || [], binaryColumns: step.result?.binaryColumns, rowCount: step.result?.rows.length || 0, rows: step.result?.rows.slice(0, DEFAULT_QUERY_PAGE_SIZE) || [],
    ...(step.result?.affectedRows !== undefined ? { affectedRows: step.result.affectedRows } : {}), ...(step.error ? { error: step.error } : {}) }))
    : sets.map(item => ({ ...(item.sql ? { sql: item.sql } : {}), columns: item.columns, binaryColumns: item.binaryColumns, rowCount: item.rows.length,
      truncated: item.truncated, elapsedMs: item.elapsedMs, ...(item.affectedRows !== undefined ? { affectedRows: item.affectedRows } : {}),
      rows: item.rows.slice(0, DEFAULT_QUERY_PAGE_SIZE) }))
  const message = sets.length > 1 ? `已执行 ${sets.length} 条` : result.message
  return { columns: result.columns, binaryColumns: result.binaryColumns, rowCount: result.rows.length, truncated: result.truncated, elapsedMs: result.elapsedMs,
    executionId, rows: result.rows.slice(0, DEFAULT_QUERY_PAGE_SIZE), ...(statements.length > 1 ? { statements } : {}),
    ...(result.steps ? { steps: result.steps } : {}),
    ...(message ? { message } : {}), ...(result.affectedRows !== undefined ? { affectedRows: result.affectedRows } : {}),
    ...(controlLost ? { controlLost: true } : {}) }
}

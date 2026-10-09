import type { Result } from './workbench.ts'
import type { SqlStep } from './sql-batch.ts'

/** Receipts own facts; bounded previews can only enrich the corresponding step. */
export function sqlReceiptSteps(result: Pick<Partial<Result>, 'steps' | 'batch'>): SqlStep[] {
  let completed = 0
  const indexed = result.batch?.some(item => item.stepIndex !== undefined)
  const byIndex = new Map(result.batch?.filter(item => item.stepIndex !== undefined).map(item => [item.stepIndex!, item]))
  return (result.steps || []).map(receipt => {
    const payload = receipt.status === 'succeeded' ? indexed ? byIndex.get(receipt.index) : result.batch?.[completed++] : undefined
    return { index: receipt.index, sql: receipt.sql, kind: 'other', status: receipt.status === 'succeeded' ? 'ok' : receipt.status === 'not-run' ? 'skipped' : receipt.status,
      result: payload ? { ...payload, affectedRows: receipt.affectedRows ?? payload.affectedRows } : receipt.status === 'succeeded' && receipt.affectedRows !== undefined ? { columns: [], rows: [], truncated: false, elapsedMs: 0, affectedRows: receipt.affectedRows } : undefined,
      error: receipt.message }
  })
}

/** Complete a requested batch from facts, never from the last bounded preview. */
export function sqlBatchReceiptSteps(selected: SqlStep[], receipt: Partial<Result> & { effect?: string; phase?: string; requestPhase?: string; message?: string }, failed = false): SqlStep[] {
  const facts = sqlReceiptSteps(receipt)
  const previews = receipt.batch || (Array.isArray(receipt.rows) ? [receipt as Result] : [])
  const normalized: SqlStep[] = selected.map((step, index) => {
    const fact = facts.find(item => item.index === index)
    if (fact) return { ...step, status: fact.status, result: fact.result, error: fact.error }
    // Legacy successful records have no steps; each actual preview owns only itself.
    if (!failed && !receipt.steps?.length && previews[index]) return { ...step, status: 'ok', result: previews[index], error: undefined }
    const notSent = failed && receipt.effect === 'none' && (receipt.phase === 'check' || receipt.requestPhase === 'before-fetch')
    const status = notSent ? receipt.requestPhase === 'before-fetch' ? 'cancelled' : index === 0 ? 'failed' : 'skipped'
      : failed && selected.length === 1 && receipt.effect === 'none' ? 'failed'
      : failed && receipt.effect !== 'unknown' && !receipt.steps?.length && selected.every(item => ['select', 'show', 'explain'].includes(item.kind)) ? 'failed' : 'unknown'
    return { ...step, status, result: undefined, error: receipt.message || '未收到该步骤的可信回执，结果未知。' }
  })
  return normalized.map(step => ['insert', 'update', 'delete'].includes(step.kind) && ['ok', 'unknown'].includes(step.status)
    ? { ...step, writeReceipt: step.status === 'ok' ? 'succeeded' : 'unknown' } : step)
}

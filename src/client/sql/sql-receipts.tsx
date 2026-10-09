import React from 'react'
import type { Result } from '../../shared/workbench.ts'
import { type SqlStep, stepStatusLabel } from '../../shared/sql-batch.ts'
import { sqlReceiptSteps } from '../../shared/sql-receipts.ts'
import { clipResultPreview } from '../../shared/execution.ts'
import { ReadonlyResultGrid } from '../results.tsx'

export function SqlReceipts({ result, localSteps, actions }: { result?: Result; localSteps?: SqlStep[]; actions?(step: SqlStep, index: number): React.ReactNode }) {
  const steps = localSteps || (result ? sqlReceiptSteps(result) : [])
  return <div className="db-sql-step-log" aria-label="逐项执行回执">{steps.map((step, index) => <article key={step.index} className={`db-sql-step-item is-${step.status}`}>
    <header><strong>{step.index + 1} · {stepStatusLabel(step.status)}</strong></header>
    <pre>{step.sql.trim()}</pre>
    {step.result?.affectedRows !== undefined && <p>影响 {step.result.affectedRows} 行</p>}
    {(step.error || step.result?.message) && <p>{step.error || step.result?.message}</p>}
    {step.result?.columns.length ? <div className="db-sql-step-preview"><ReadonlyResultGrid result={clipResultPreview(step.result)!} /></div> : null}
    {step.status === 'ok' && !step.result && <p className="db-muted">结果预览未保留。</p>}
    {step.status === 'unknown' && <p role="status">数据库效果未知，请查看原操作并在原目标核验；不要重新提交此写入。</p>}
    {actions?.(step, index)}
  </article>)}</div>
}

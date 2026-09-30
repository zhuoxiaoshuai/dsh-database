import React, { useEffect, useState } from 'react'
import type { Connection, MaintenanceResult, WorkspaceBridge } from '../shared/workbench.ts'
import type { DmlOp } from './execute-dml.ts'

export type { DmlOp }

export function MaintenanceReview({
  bridge, connection, schema, table, operation, onDone, onCancel,
}: {
  bridge: WorkspaceBridge
  connection: Connection
  schema: string
  table: string
  operation: DmlOp
  onDone(): void
  onCancel(): void
}) {
  const [review, setReview] = useState<MaintenanceResult>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    setBusy(true); setError('')
    void bridge.maintenance!(connection, { kind: 'preview', schema, table, operation }).then(value => {
      if (alive) setReview(value)
    }).catch(e => { if (alive) setError(e instanceof Error ? e.message : '无法预览变更') }).finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [bridge, connection, schema, table, operation])
  const confirm = async () => {
    if (!review?.id || busy) return
    setBusy(true); setError('')
    try {
      const result = await bridge.maintenance!(connection, { kind: 'execute', id: review.id, confirmed: true })
      if (result.status === 'success') onDone()
      else setError(result.message || '结果未知，请核验数据库实际状态。')
    } catch (e) { setError(e instanceof Error ? e.message : '执行失败') }
    finally { setBusy(false) }
  }
  const back = () => {
    if (review?.id) void bridge.maintenance!(connection, { kind: 'reject', id: review.id }).catch(() => {})
    onCancel()
  }
  return <div className="db-review-strip">
    <strong>{operation.kind === 'insert' ? '新增' : operation.kind === 'delete' ? '删除' : '修改'} · {schema}.{table}</strong>
    {busy && !review && <p role="status">正在生成预览…</p>}
    {error && <p className="db-error" role="alert">{error}</p>}
    {review?.sql && <pre className="db-cell-detail">{review.sql}</pre>}
    {!!review?.params?.length && <pre className="db-cell-detail">参数：{JSON.stringify(review.params)}</pre>}
    <p className="db-muted">{connection.environment.toUpperCase()} · 预期影响 {review?.expectedRows ?? 1} 行{review?.expiresAt ? ` · 审批 ${new Date(review.expiresAt).toLocaleTimeString()} 前有效` : ''}</p>
    <div className="db-catalog-tools">
      <button disabled={busy} onClick={back}>取消</button>
      <button className="db-primary" disabled={busy || !review?.id} onClick={() => void confirm()}>{busy ? '提交中…' : '确认并执行'}</button>
    </div>
  </div>
}

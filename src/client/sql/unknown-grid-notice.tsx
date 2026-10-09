import React, { useEffect, useState } from 'react'
import type { Connection } from '../../shared/workbench.ts'
import type { UnknownGridWrite } from '../execute-dml.ts'

/** A view of the original uncertain write, never a new execution or an approval. */
export function UnknownGridNotice({ snapshot, connection, onOpenTarget, onRefresh }: {
  snapshot: UnknownGridWrite; connection: Connection; onOpenTarget(): void; onRefresh(): void
}) {
  const [useCurrent, setUseCurrent] = useState(false)
  useEffect(() => setUseCurrent(false), [connection.id, connection.generation, snapshot.previewId])
  const matches = connection.id === snapshot.connectionId && connection.generation === snapshot.generation
  const enabled = connection.live && connection.id === snapshot.connectionId && (matches || useCurrent)
  return <aside className="db-info-note" role="status" aria-label="未知写入核验">
    <p>结果未知 · {snapshot.connectionName} · {snapshot.schema}.{snapshot.table} · {snapshot.generation} · {snapshot.createdAt}</p>
    <details><summary>查看原操作</summary><pre className="db-cell-detail">{snapshot.sql || 'SQL 预览未保留。'}</pre><pre>{JSON.stringify(snapshot.params)}</pre><small>{snapshot.executionId || snapshot.previewId}</small></details>
    {!matches && <label><input type="checkbox" checked={useCurrent} onChange={event => setUseCurrent(event.target.checked)} />原代次已失效；我已明确选择当前连接进行核验</label>}
    <button type="button" disabled={!enabled} onClick={onOpenTarget}>打开原目标核验</button>
    <button type="button" disabled={!enabled} onClick={onRefresh}>丢弃旧草稿并刷新</button>
    <p>核验使用新读取；刷新失败时继续冻结编辑。原写入不会再次提交。</p>
  </aside>
}

import React from 'react'

export function AiControlBar({
  controller, pending, connectionName, target, onTakeover, onReturnAi,
}: {
  controller: 'ai' | 'user'
  pending?: 'ai' | 'user'
  connectionName: string
  target: string
  onTakeover(): void
  onReturnAi(): void
}): React.ReactElement {
  const label = pending ? (pending === 'ai' ? '归还中…' : '接管中…') : controller === 'ai' ? 'AI 控制中' : '用户控制'
  return <span className="db-ai-control">
    <span className="db-muted">{label} · {connectionName} · {target}</span>
    {controller === 'ai'
      ? <button type="button" className="db-sql-toolbar-btn" disabled={!!pending} onClick={onTakeover}>{pending ? label : '接管'}</button>
      : <button type="button" className="db-sql-toolbar-btn" disabled={!!pending} onClick={onReturnAi}>{pending ? label : '归还 AI'}</button>}
  </span>
}

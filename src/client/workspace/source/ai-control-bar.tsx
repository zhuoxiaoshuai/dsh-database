import React from 'react'

export function AiControlBar({
  controller, connectionName, target, onTakeover, onReturnAi,
}: {
  controller: 'ai' | 'user'
  connectionName: string
  target: string
  onTakeover(): void
  onReturnAi(): void
}): React.ReactElement {
  const label = controller === 'ai' ? 'AI 控制中' : '用户控制'
  return <span className="db-ai-control">
    <span className="db-muted">{label} · {connectionName} · {target}</span>
    {controller === 'ai'
      ? <button type="button" className="db-sql-toolbar-btn" onClick={onTakeover}>接管</button>
      : <button type="button" className="db-sql-toolbar-btn" onClick={onReturnAi}>归还 AI</button>}
  </span>
}

import React from 'react'
import type { RedisValue } from '../../shared/redis-result.ts'
import { RedisValueView } from './value.tsx'

export function RedisResultView({ result }: { result?: { result?: RedisValue; truncated?: boolean; elapsedMs?: number; executionStatus?: string }; onUse?: (text: string) => void }): React.ReactElement {
  if (!result) return <p className="db-muted db-query-result-empty">执行命令后在此显示结果。</p>
  if (result.executionStatus === 'unknown') return <p role="alert" className="db-error">命令结果未知，请核验；不会自动重试。</p>
  if (result.executionStatus === 'cancelled') return <p role="status" className="db-muted">命令已取消，未派发。</p>
  if (result.executionStatus === 'failed' && !result.result) return <p role="alert" className="db-error">命令执行失败，请查看执行记录。</p>
  return <div className="db-redis-reply-body" role="status">
    <RedisValueView data={result.result} />
    {result.truncated === true && <p className="db-muted">结果超过显示上限，已截断。</p>}
    {result.elapsedMs !== undefined && <p className="db-muted">{String(result.elapsedMs)} ms</p>}
  </div>
}

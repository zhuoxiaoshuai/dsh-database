import React from 'react'
import type { RedisValue } from '../../shared/redis-result.ts'
import { RedisValueView } from './value.tsx'

export function RedisResultView({ result }: { result?: { result?: RedisValue; truncated?: boolean; elapsedMs?: number }; onUse?: (text: string) => void }): React.ReactElement {
  if (!result) return <p className="db-muted db-query-result-empty">执行命令后在此显示结果。</p>
  return <div className="db-redis-reply-body" role="status">
    <RedisValueView data={result.result} />
    {result.truncated === true && <p className="db-muted">结果超过显示上限，已截断。</p>}
    {result.elapsedMs !== undefined && <p className="db-muted">{String(result.elapsedMs)} ms</p>}
  </div>
}

import React from 'react'
import type { ExecutionRecord } from '../../shared/execution.ts'
import type { ExecutionResultEnvelope } from '../../shared/execution-result.ts'
import type { RedisValue } from '../../shared/redis-result.ts'
import { RedisValueView } from './value.tsx'
import { isLegacyRedisHistoryExecution } from './history.ts'
import type { HistoryDetailSource } from '../data-sources/types.ts'
import { previewJson } from '../workspace/parts/preview-json.tsx'

export const redisHistory: HistoryDetailSource = {
  id: 'redis', legacyHistoryVisible: isLegacyRedisHistoryExecution,
  renderText: (record: ExecutionRecord) => <section className="db-ai-record-section">
    <strong>Redis 操作</strong><p>{record.title || record.operation}</p><p className="db-muted">完整参数不保存在执行记录中。可在 AI Query 中查看当前共编命令。</p>
  </section>,
  resultEnvelope: (record: ExecutionRecord, payload: unknown): ExecutionResultEnvelope => ({
    sourceId: 'redis', kind: 'resp', status: record.status,
    elapsedMs: (payload as { elapsedMs?: number } | undefined)?.elapsedMs,
    truncated: (payload as { truncated?: boolean } | undefined)?.truncated === true, payload,
  }),
  renderResult: envelope => {
    const reply = envelope.payload as { result?: RedisValue; truncated?: boolean } | undefined
    return reply?.result ? <div className="db-redis-reply-body"><RedisValueView data={reply.result} />{reply.truncated && <p className="db-muted">结果已截断。</p>}</div>
      : previewJson(envelope.payload)
  },
}

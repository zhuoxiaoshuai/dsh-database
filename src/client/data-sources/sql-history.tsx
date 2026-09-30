import React from 'react'
import type { ExecutionRecord } from '../../shared/execution.ts'
import type { ExecutionResultEnvelope } from '../../shared/execution-result.ts'
import type { Result } from '../../shared/workbench.ts'
import { ReadonlyResultGrid } from '../results.tsx'
import type { HistoryDetailSource } from './types.ts'
import { previewJson } from '../workspace/parts/preview-json.tsx'

const renderText = (record: ExecutionRecord, onUse?: (text: string, schema?: string) => void) => {
  const text = record.executedSql || record.sql || (typeof record.draft?.sql === 'string' ? record.draft.sql : '')
  return <section className="db-ai-record-section db-ai-record-sql">
    <div className="db-ai-record-sql-head"><strong>SQL</strong>{text.trim() && <button type="button" className="db-primary db-ai-write-btn" onClick={() => onUse?.(text, record.schema)}>写入</button>}</div>
    <pre className="db-cell-detail">{text || '无 SQL'}</pre>
  </section>
}
const resultEnvelope = (record: ExecutionRecord, payload: unknown): ExecutionResultEnvelope => ({
  sourceId: record.dialect as 'mysql' | 'oracle', kind: 'grid', status: record.status,
  elapsedMs: (payload as Partial<Result> | undefined)?.elapsedMs, truncated: (payload as Partial<Result> | undefined)?.truncated === true, payload,
})
const renderResult = (envelope: ExecutionResultEnvelope) => {
  const result = envelope.payload as Partial<Result> | undefined
  return Array.isArray(result?.columns) && Array.isArray(result?.rows)
    ? <ReadonlyResultGrid result={result as Result} />
    : previewJson(envelope.payload)
}

export const sqlHistory = (id: 'mysql' | 'oracle'): HistoryDetailSource => ({ id, renderText, resultEnvelope, renderResult })

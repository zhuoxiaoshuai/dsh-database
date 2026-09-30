import React from 'react'
import type { ExecutionRecord } from '../../shared/execution.ts'
import { KafkaResultView } from './results.tsx'
import type { HistoryDetailSource } from '../data-sources/types.ts'

export const kafkaHistory: HistoryDetailSource = {
  id: 'kafka',
  renderText: (record: ExecutionRecord) => <section className="db-ai-record-section">
    <strong>Kafka 读取</strong><p>{record.title || record.operation}</p>
    <p className="db-muted">消息正文、Key 和 Headers 不保存在执行记录中。</p>
  </section>,
  resultEnvelope: (record, payload) => ({ sourceId: 'kafka', kind: 'kafka', status: record.status, truncated: false, payload }),
  renderResult: envelope => <KafkaResultView result={envelope.payload as React.ComponentProps<typeof KafkaResultView>['result']} />,
}

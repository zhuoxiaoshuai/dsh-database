import React from 'react'
import type { ExecutionRecord } from '../../shared/execution.ts'
import { KafkaResultView } from './results.tsx'
import type { HistoryDetailSource } from '../data-sources/types.ts'

export const kafkaHistory: HistoryDetailSource = {
  id: 'kafka',
  renderText: (record: ExecutionRecord) => <section className="db-ai-record-section">
    <strong>{record.operation === 'kafka_produce' ? 'Kafka 发布' : 'Kafka 读取'}</strong><p>{record.title || record.operation}</p>
    <p className="db-muted">消息正文、Key 和 Headers 不保存在执行记录中。发布结果未知时请核对 Topic 后再决定是否重发。</p>
  </section>,
  resultEnvelope: (record, payload) => ({ sourceId: 'kafka', kind: 'kafka', status: record.status, truncated: false, payload }),
  renderResult: envelope => <KafkaResultView result={envelope.payload as React.ComponentProps<typeof KafkaResultView>['result']} />,
}

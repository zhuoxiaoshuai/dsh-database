import React from 'react'
import { previewJson } from '../workspace/parts/preview-json.tsx'
import type { HistoryDetailSource } from './types.ts'

export const nacosHistory: HistoryDetailSource = {
  id: 'nacos',
  renderText: record => <section className="db-ai-record-section"><strong>Nacos</strong><p>{record.title || record.operation}</p></section>,
  resultEnvelope: (record, payload) => ({ sourceId: 'nacos', kind: 'nacos', status: record.status, truncated: false, payload }),
  renderResult: envelope => previewJson(envelope.payload),
}

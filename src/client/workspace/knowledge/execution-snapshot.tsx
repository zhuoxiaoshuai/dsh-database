import React from 'react'
import type { KnowledgeExecutionSnapshot } from './execution-owner.ts'

export function KnowledgeExecutionSnapshotView({ snapshot, text }: { snapshot?: KnowledgeExecutionSnapshot; text: string }) {
  if (!snapshot) return null
  return <details className="db-info-note" aria-label="本次执行内容">
    <summary>{snapshot.editorText !== text ? '结果来自修改前的内容' : '本次执行内容'} · {snapshot.target}</summary>
    <pre>{snapshot.executedText}</pre>
  </details>
}

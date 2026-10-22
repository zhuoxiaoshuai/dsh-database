import React from 'react'
import type { KnowledgeTidyChange } from '../../../shared/knowledge.ts'
import { TextDiff } from '../parts/layout/text-diff.tsx'
import type { KnowledgeTidyController } from './use-knowledge-tidy.ts'

function field(label: string, before: string, after: string): React.ReactElement {
  const changed = before !== after
  return <p><strong>{label}</strong> {changed ? <>{before || '（空）'} → {after || '（空）'}</> : (after || '（空）')}</p>
}

export function KnowledgeTidyReview({ change, busy, onApprove, onReject }: {
  change: KnowledgeTidyChange
  busy?: boolean
  onApprove(): void
  onReject(): void
}): React.ReactElement {
  const after = change.after
  const archived = change.kind === 'archive'
  return <div className="db-template-tidy-review">
    <p className="db-info-note" role="status">{archived ? '这条将被归档，不再出现在经验库。' : change.risk === 'executable-changed' ? '可执行内容已变化，请对照右侧正文。' : '仅说明、注释或格式变化。'}</p>
    <div className="db-template-meta-inline">
      {field('标题', change.before.title, archived ? '' : after?.title || '')}
      {field('简介', change.before.summary, archived ? '' : after?.summary || '')}
      {field('标签', change.before.tags.join(', '), archived ? '' : (after?.tags || []).join(', '))}
    </div>
    {!!change.archiveTargets?.length && <section aria-label="同时归档的经验">
      <p className="db-info-note">通过这条还将归档以下 {change.archiveTargets.length} 条经验：</p>
      {change.archiveTargets.map(target => <details key={target.id}>
        <summary>{target.before.title} · v{target.expectedVersion}</summary>
        <p>{target.before.summary}</p>
        <p>{target.before.tags.join(', ')}</p>
        <pre>{target.before.text}</pre>
      </details>)}
    </section>}
    <div className="db-catalog-tools">
      <button type="button" className="db-sql-toolbar-btn db-primary" disabled={busy} onClick={onApprove}>通过这条</button>
      <button type="button" className="db-sql-toolbar-btn" disabled={busy} onClick={onReject}>驳回这条</button>
    </div>
    <TextDiff before={change.before.text} after={archived ? '' : after?.text || ''} beforeLabel="当前经验" afterLabel={archived ? '归档后' : '整理后'} label="经验差异" />
  </div>
}

export function tidyRiskLabel(change: KnowledgeTidyChange): string {
  if (change.kind === 'archive') return '归档'
  return change.risk === 'executable-changed' ? '可执行内容已变化' : '说明或格式'
}

export function KnowledgeTidyBanner({ tidy }: { tidy: KnowledgeTidyController }): React.ReactElement | null {
  if (!tidy.changes.length && !tidy.notice && !tidy.error) return null
  return <div className="db-template-tidy-banner">
    {!!tidy.changes.length && <div className="db-catalog-tools"><strong>待审批 {tidy.changes.length} 条</strong>
      <button type="button" className="db-sql-toolbar-btn db-primary" disabled={tidy.busy} onClick={() => tidy.approve()}>全部通过</button>
      <button type="button" className="db-sql-toolbar-btn" disabled={tidy.busy} onClick={() => tidy.reject()}>全部驳回</button>
    </div>}
    {tidy.notice && <p className="db-info-note" role="status">{tidy.notice}</p>}
    {tidy.error && <p className="db-error" role="alert">{tidy.error}</p>}
  </div>
}

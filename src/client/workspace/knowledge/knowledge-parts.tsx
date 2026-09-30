import React from 'react'
import { Trash2 } from 'lucide-react'

export type KnowledgeListRow = { id: string; title: string; subtitle: string; summary: string }

export function KnowledgeItemList({ items, selectedId, busy, empty, archiveLabel = '归档', onSelect, onArchive }: {
  items: readonly KnowledgeListRow[]
  selectedId?: string
  busy?: boolean
  empty: string
  archiveLabel?: string
  onSelect(id: string, event: React.MouseEvent<HTMLButtonElement>): void
  onArchive(id: string, event: React.MouseEvent<HTMLButtonElement>): void
}): React.ReactElement {
  return <>
    {items.map(item => <div key={item.id} className={`db-template-list-row${selectedId === item.id ? ' is-active' : ''}`}>
      <button type="button" className="db-template-list-main" onClick={event => onSelect(item.id, event)}>
        <strong title={item.title}>{item.title}</strong>
        <small title={item.subtitle}>{item.subtitle}</small>
        <span title={item.summary}>{item.summary}</span>
      </button>
      <button type="button" className="db-icon-button db-template-list-delete" aria-label={`${archiveLabel} ${item.title}`} disabled={busy} onClick={event => onArchive(item.id, event)}><Trash2 size={14} /></button>
    </div>)}
    {!items.length && <p className="db-info-note">{empty}</p>}
  </>
}

export function KnowledgeMetadataFields({ title, summary, tags, onTitle, onSummary, onTags }: {
  title: string
  summary: string
  tags: string
  onTitle(value: string): void
  onSummary(value: string): void
  onTags(value: string): void
}): React.ReactElement {
  return <div className="db-template-meta-inline">
    <label className="db-form-label">标题<input value={title} onChange={event => onTitle(event.target.value)} maxLength={240} /></label>
    <label className="db-form-label">简介<input value={summary} onChange={event => onSummary(event.target.value)} maxLength={240} /></label>
    <label className="db-form-label">标签<input value={tags} onChange={event => onTags(event.target.value)} placeholder="用逗号分隔" /></label>
  </div>
}

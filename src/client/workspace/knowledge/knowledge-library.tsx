import React, { useEffect, useState } from 'react'
import { ExecutionWorkbench } from '../source/execution-workbench.tsx'
import { QueryResultFrame } from '../source/query-result-frame.tsx'
import { KnowledgeLayout } from './knowledge-layout.tsx'
import { KnowledgeItemList, KnowledgeMetadataFields, type KnowledgeListRow } from './knowledge-parts.tsx'

/** Source modules supply the editor and result; list, draft metadata and actions stay the same. */
export function KnowledgeLibrary({ sourceName, items, selectedId, onSelect, search, onSearch, title, onTitle, summary, onSummary,
  tags, onTags, editor, result, error, runError, busy, canRun, onRun, onSave, onUse, onArchive,
  analysis, execution, onSearchSubmit, searchLabel = '搜索经验库', draftLabel = '＋ 新建', archiveLabel = '归档', empty = '还没有已保存的知识条目。', embedded = true, onClose,
}: KnowledgeLibraryProps): React.ReactElement {
  const [resultOpen, setResultOpen] = useState(true)
  useEffect(() => { if (runError) setResultOpen(true) }, [runError])
  return <KnowledgeLayout label={`${sourceName} 经验库`} className="db-knowledge-library" error={error} embedded={embedded} onClose={onClose}
    listHeader={<><strong>经验库</strong><form className="db-template-list-search" onSubmit={event => { event.preventDefault(); onSearchSubmit?.() }}><input aria-label={searchLabel} value={search} onChange={event => onSearch(event.target.value)} placeholder="搜索标题或命令" /></form></>}
    listBody={<>
          <button type="button" className={`db-template-list-main${!selectedId ? ' is-active' : ''}`} onClick={() => onSelect('')}>{draftLabel}</button>
          <KnowledgeItemList items={items}
            selectedId={selectedId} busy={busy} empty={empty} archiveLabel={archiveLabel} onSelect={id => onSelect(id)} onArchive={onArchive} />
    </>}
  >
        <KnowledgeMetadataFields title={title} summary={summary} tags={tags} onTitle={onTitle} onSummary={onSummary} onTags={onTags} />
        {analysis}
        {execution || <ExecutionWorkbench
          className="db-sql-run-workspace"
          resultOpen={resultOpen}
          onResultOpenChange={setResultOpen}
          toolbar={<div className="db-catalog-tools db-sql-toolbar">
            <button type="button" className="db-sql-toolbar-btn db-primary" disabled={busy || !canRun} onClick={onRun}>试运行</button>
            <button type="button" className="db-sql-toolbar-btn" disabled={busy} onClick={onSave}>保存</button>
            <button type="button" className="db-sql-toolbar-btn" disabled={busy} onClick={onUse}>用于查询</button>
          </div>}
          rail={<button type="button" className="db-text-button" disabled={busy || !canRun} onClick={onRun}>试运行</button>}
          editor={editor}
          result={<QueryResultFrame empty={<p className="db-muted db-query-result-empty">试运行结果会显示在这里。</p>}>{runError ? <p role="alert" className="db-error">{runError}</p> : result}</QueryResultFrame>}
        />}
  </KnowledgeLayout>
}

export type KnowledgeLibraryProps = {
  sourceName: string
  items: readonly KnowledgeListRow[]
  selectedId?: string
  onSelect(id: string): void
  search: string
  onSearch(value: string): void
  title: string
  onTitle(value: string): void
  summary: string
  onSummary(value: string): void
  tags: string
  onTags(value: string): void
  editor?: React.ReactNode
  result?: React.ReactNode
  analysis?: React.ReactNode
  execution?: React.ReactNode
  onSearchSubmit?(): void
  searchLabel?: string
  draftLabel?: string
  archiveLabel?: string
  empty?: string
  embedded?: boolean
  onClose?(): void
  error?: string
  runError?: string
  busy?: boolean
  canRun?: boolean
  onRun(): void
  onSave(): void
  onUse(): void
  onArchive(id: string, event: React.MouseEvent<HTMLButtonElement>): void
}

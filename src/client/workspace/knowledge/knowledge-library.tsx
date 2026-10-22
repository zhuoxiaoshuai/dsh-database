import {ResourceError} from '../parts/feedback/resource-error.tsx'
import React, { useEffect, useState } from 'react'
import { ExecutionWorkbench } from '../source/execution-workbench.tsx'
import { QueryResultFrame } from '../parts/layout/query-result-frame.tsx'
import { KnowledgeLayout } from './knowledge-layout.tsx'
import { KnowledgeItemList, KnowledgeMetadataFields, type KnowledgeListRow } from './knowledge-parts.tsx'
import { KnowledgeTidyBanner, KnowledgeTidyReview, tidyRiskLabel } from './knowledge-tidy.tsx'
import type { KnowledgeTidyController } from './use-knowledge-tidy.ts'

/** Source modules supply the editor and result; list, draft metadata and actions stay the same. */
export function KnowledgeLibrary({ sourceName, items, selectedId, onSelect, search, onSearch, title, onTitle, summary, onSummary,
  tags, onTags, editor, result, error, runError, busy, canRun, onRun, onSave, onUse, onArchive,
  analysis, execution, executionInfo, onSearchSubmit, searchLabel = '搜索经验库', draftLabel = '＋ 新建', archiveLabel = '归档', empty = '还没有已保存的知识条目。', embedded = true, onClose,
  tidy, editorDisabled = false,
}: KnowledgeLibraryProps): React.ReactElement {
  const [resultOpen, setResultOpen] = useState(true)
  useEffect(() => { if (runError) setResultOpen(true) }, [runError])
  const review = tidy?.changes.find(change => change.id === tidy.selectedId)
  return <KnowledgeLayout label={`${sourceName} 经验库`} className="db-knowledge-library" error={error} embedded={embedded} onClose={onClose}
    listHeader={<><strong>经验库</strong>{tidy && <KnowledgeTidyBanner tidy={tidy} />}<form className="db-template-list-search" onSubmit={event => { event.preventDefault(); onSearchSubmit?.() }}><input aria-label={searchLabel} value={search} onChange={event => onSearch(event.target.value)} placeholder="搜索标题或命令" /></form></>}
    listBody={<>
          {tidy?.changes.map(change => <button type="button" key={change.id} className={`db-template-list-main${tidy.selectedId === change.id ? ' is-active' : ''}`} onClick={() => tidy.select(change.id)}>
            <strong>{change.after?.title || change.before.title}</strong>
            <small>{tidyRiskLabel(change)}</small>
          </button>)}
          <button type="button" className={`db-template-list-main${!selectedId && !review ? ' is-active' : ''}`} onClick={() => { tidy?.select(''); onSelect('') }}>{draftLabel}</button>
          <KnowledgeItemList items={items}
            selectedId={review ? '' : selectedId} busy={busy || tidy?.busy} empty={empty} archiveLabel={archiveLabel} onSelect={id => { tidy?.select(''); onSelect(id) }} onArchive={onArchive} />
    </>}
  >
        {review && tidy ? <KnowledgeTidyReview change={review} busy={tidy.busy} onApprove={() => tidy.approve(review.id)} onReject={() => tidy.reject(review.id)} /> : <>
        <KnowledgeMetadataFields disabled={editorDisabled} title={title} summary={summary} tags={tags} onTitle={onTitle} onSummary={onSummary} onTags={onTags} />
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
          result={<QueryResultFrame secondaryHeader={executionInfo} empty={<p className="db-muted db-query-result-empty">试运行结果会显示在这里。</p>}>{runError ? <><ResourceError message={runError}/>{result}</> : result}</QueryResultFrame>}
        />}
        </>}
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
  executionInfo?: React.ReactNode
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
  editorDisabled?: boolean
  canRun?: boolean
  onRun(): void
  onSave(): void
  onUse(): void
  onArchive(id: string, event: React.MouseEvent<HTMLButtonElement>): void
  tidy?: KnowledgeTidyController
}

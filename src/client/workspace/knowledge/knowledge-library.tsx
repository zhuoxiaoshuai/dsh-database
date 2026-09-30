import React, { useEffect, useState } from 'react'
import type { KnowledgeItem } from '../../../shared/knowledge.ts'
import { ExecutionWorkbench } from '../source/execution-workbench.tsx'
import { QueryResultFrame } from '../source/query-result-frame.tsx'
import { KnowledgeLayout } from './knowledge-layout.tsx'
import { KnowledgeItemList, KnowledgeMetadataFields } from './knowledge-parts.tsx'

/** Source modules supply the editor and result; list, draft metadata and actions stay the same. */
export function KnowledgeLibrary({ sourceName, items, selectedId, onSelect, search, onSearch, title, onTitle, summary, onSummary,
  tags, onTags, editor, result, error, runError, busy, canRun, onRun, onSave, onUse, onArchive,
}: {
  sourceName: string
  items: KnowledgeItem[]
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
  editor: React.ReactNode
  result: React.ReactNode
  error?: string
  runError?: string
  busy?: boolean
  canRun?: boolean
  onRun(): void
  onSave(): void
  onUse(): void
  onArchive(id: string): void
}): React.ReactElement {
  const [resultOpen, setResultOpen] = useState(true)
  useEffect(() => { if (runError) setResultOpen(true) }, [runError])
  return <KnowledgeLayout label={`${sourceName} 经验库`} className="db-knowledge-library" error={error}
    listHeader={<><strong>经验库</strong><input aria-label="搜索经验库" value={search} onChange={event => onSearch(event.target.value)} placeholder="搜索标题或命令" /></>}
    listBody={<>
          <button type="button" className={`db-template-list-main${!selectedId ? ' is-active' : ''}`} onClick={() => onSelect('')}>＋ 新建</button>
          <KnowledgeItemList items={items.map(item => ({ id: item.id, title: item.title, subtitle: `${item.analysis.operation} · v${item.version}`, summary: item.summary }))}
            selectedId={selectedId} busy={busy} empty="还没有已保存的知识条目。" onSelect={id => onSelect(id)} onArchive={id => onArchive(id)} />
    </>}
  >
        <KnowledgeMetadataFields title={title} summary={summary} tags={tags} onTitle={onTitle} onSummary={onSummary} onTags={onTags} />
        <p className="db-info-note">未完成语义分析；当前仅按命令及参数原文指纹去重。保存不会执行，试运行时重新检查权限。</p>
        <ExecutionWorkbench
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
        />
  </KnowledgeLayout>
}

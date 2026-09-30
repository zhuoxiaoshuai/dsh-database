import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { formatDetailValue, formatPreview, isBinaryPlaceholder } from '../shared/cell-value.ts'
import { useDragResize } from './workspace/parts/use-drag-resize.ts'
import { formatValue } from './workspace/parts/formatted-cell-value.ts'

export type CellDetailViewerHandle = { focusEditor(): void }

export const CellDetailViewer = forwardRef<CellDetailViewerHandle, {
  column?: string
  value: string | null | undefined
  editable?: boolean
  onApply?(value: string | null): void
  expanded: boolean
  height: number
  maxHeight: number
  onExpandedChange(expanded: boolean): void
  onHeightChange(height: number): void
  onResizeStart?(): void
}>(function CellDetailViewer({
  column, value, editable, onApply, expanded, height, maxHeight, onExpandedChange, onHeightChange, onResizeStart,
}, ref) {
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState('')
  const [kind, setKind] = useState('json')
  const [search, setSearch] = useState('')
  const [wrap, setWrap] = useState(true)
  const empty = value === undefined
  const binary = isBinaryPlaceholder(value ?? null)
  const isNull = value === null
  const canEdit = !!editable && !empty && !binary && !isNull
  useEffect(() => {
    if (value === undefined || value === null || value === '') { setDraft(''); return }
    setDraft(formatDetailValue(value))
  }, [value, column])
  useEffect(() => { setSearch('') }, [value, column])
  useImperativeHandle(ref, () => ({
    focusEditor() { editorRef.current?.focus() },
  }))
  const copy = async () => {
    const text = isNull ? 'NULL' : value === '' ? '' : (value ?? '')
    try { await navigator.clipboard.writeText(text) } catch { /* ignore */ }
  }
  const apply = () => {
    if (!canEdit) return
    onApply?.(draft)
  }
  const dragOrigin = useRef(height)
  const onResize = useDragResize((start, current) => {
    onHeightChange(dragOrigin.current + start.clientY - current.clientY)
  })
  const raw = isNull ? 'NULL' : value === '' ? '""' : (value ?? '')
  const displayed = useMemo(() => binary || isNull ? raw : formatValue(raw, kind), [binary, isNull, raw, kind])
  if (!expanded) return <button
    type="button"
    className="db-cell-preview-bar"
    aria-label="展开字段详情"
    disabled={empty}
    onClick={() => onExpandedChange(true)}
  >
    <ChevronUp size={14} />
    <strong>{column || '字段详情'}</strong>
    <span>{empty ? '单击单元格查看完整内容' : formatPreview(value ?? null)}</span>
  </button>
  return <div className="db-cell-detail-viewer" style={{ height: Math.min(height, maxHeight) }} aria-label="字段详情">
    <div className="db-cell-detail-resizer" role="separator" aria-orientation="horizontal" aria-label="调整字段详情高度" onPointerDown={event => { dragOrigin.current = height; onResizeStart?.(); onResize(event) }} />
    <header className="db-cell-detail-head">
      <button type="button" className="db-cell-detail-toggle" aria-label="收起字段详情" onClick={() => onExpandedChange(false)}><ChevronDown size={14} /></button>
      <strong>{column || (empty ? '未选中单元格' : '单元格')}</strong>
      {!empty && <input className="db-cell-detail-search" aria-label="字段详情内搜索" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索内容" />}
      <div className="db-cell-detail-actions">
        <select aria-label="字段详情格式" value={kind} onChange={event => setKind(event.target.value)}>
          <option value="raw">原文</option>
          <option value="json">JSON</option>
          <option value="xml">XML</option>
        </select>
        <label><input type="checkbox" checked={wrap} onChange={event => setWrap(event.target.checked)} />换行</label>
        <button type="button" disabled={empty} onClick={() => void copy()}>复制</button>
        {canEdit && <button type="button" className="db-primary" onClick={apply}>应用到单元格</button>}
      </div>
    </header>
    {search && <p className="db-cell-detail-search-status">{displayed.includes(search) ? `找到 ${displayed.split(search).length - 1} 处` : '未找到'}</p>}
    {empty ? <p className="db-muted db-cell-detail-empty">单击单元格查看完整内容。</p>
      : canEdit ? <textarea ref={editorRef} className="db-cell-detail-editor" aria-label={`编辑 ${column || '单元格'}`} value={draft} onChange={e => setDraft(e.target.value)} spellCheck={false} />
      : <pre className={`db-cell-detail${isNull || value === '' ? ' db-null' : ''}`} style={{ whiteSpace: wrap ? 'pre-wrap' : 'pre' }}>{displayed}</pre>}
  </div>
})

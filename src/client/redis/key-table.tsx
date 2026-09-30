import React, { useEffect, useMemo, useState } from 'react'
import { Check, Copy, Eye, Pencil, Trash2 } from 'lucide-react'
import { filterRows, filterTime, rowCopyText, rowPreview, rowSubmittable, sortRows, type KeyColumn, type KeyRow } from './key-model.ts'

export function RedisKeyTable({
  name, kind, columns, rows, more, revision, writing, sequence = true, scoreSort = false, timeFilter = false,
  allowEdit = true, allowDelete = true, repeatCreate = false, createFields, wrapColumn, onCreate, onEdit, onDelete, onCopy, onCell,
}: {
  name: string
  kind: string
  columns: KeyColumn[]
  rows: KeyRow[]
  more?: boolean
  revision: unknown
  writing?: boolean
  sequence?: boolean
  scoreSort?: boolean
  timeFilter?: boolean
  allowEdit?: boolean
  allowDelete?: boolean
  repeatCreate?: boolean
  createFields: { key: string; label: string }[]
  wrapColumn?: string
  onCreate?(rows: Record<string, string>[]): void
  onEdit?(row: KeyRow, values: Record<string, string>): void
  onDelete?(row: KeyRow): void
  onCopy(text: string): void
  onCell?(column: string, row: KeyRow): void
}): React.ReactElement {
  const [keyword, setKeyword] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [sortKey, setSortKey] = useState<string>()
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc')
  const [creating, setCreating] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>[]>([])
  const [editing, setEditing] = useState<string>()
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [pendingDelete, setPendingDelete] = useState<string>()
  const [preview, setPreview] = useState('')
  const [formError, setFormError] = useState('')
  useEffect(() => { setKeyword(''); setSortKey(undefined); setDirection('desc'); setFrom(''); setTo('') }, [name])
  useEffect(() => { setCreating(false); setEditing(undefined); setPendingDelete(undefined); setPreview(''); setFormError('') }, [revision])
  const activeKey = sortKey ?? (scoreSort ? 'score' : undefined)
  const activeDir = direction
  const shown = useMemo(() => {
    let next = filterRows(rows, columns, keyword)
    if (timeFilter) next = filterTime(next, from, to)
    if (activeKey) next = sortRows(next, activeKey, activeDir)
    return next
  }, [rows, columns, keyword, timeFilter, from, to, activeKey, activeDir])
  const blank = () => Object.fromEntries(createFields.map(field => [field.key, '']))
  const startCreate = () => { setCreating(true); setDrafts([blank()]); setFormError(''); setEditing(undefined) }
  const submitCreate = () => {
    if (drafts.some(row => !rowSubmittable(kind, row))) { setFormError('请填写完整后再添加。'); return }
    setFormError('')
    onCreate?.(drafts)
  }
  const startEdit = (row: KeyRow) => {
    if (!allowEdit || writing) return
    setEditing(row.id)
    setEditValues(Object.fromEntries(createFields.map(field => [field.key, row.cells[field.key] ?? ''])))
    setCreating(false)
    setFormError('')
  }
  const submitEdit = (row: KeyRow) => {
    if (!rowSubmittable(kind, editValues)) { setFormError('请填写完整后再保存。'); return }
    setFormError('')
    onEdit?.(row, editValues)
  }
  const toggleSort = (key: string) => {
    if (sortKey === key) setDirection(current => current === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setDirection('asc') }
  }
  const aligned = createFields.every(field => columns.some(column => column.key === field.key))
  const formColumns = aligned ? columns : createFields
  const total = `Total: ${rows.length}${more ? ' · 未完' : ''}`
  return <>
    <div className="db-redis-key-tools">
      <div className="db-redis-key-tools-main">
        {onCreate && <button className="db-redis-btn db-primary" type="button" disabled={writing} onClick={startCreate}>Add New Line</button>}
        {scoreSort && <>
          <button className={activeKey === 'score' && activeDir === 'desc' ? 'db-redis-btn db-primary' : 'db-redis-btn'} type="button" onClick={() => { setSortKey('score'); setDirection('desc') }}>DESC</button>
          <button className={activeKey === 'score' && activeDir === 'asc' ? 'db-redis-btn db-primary' : 'db-redis-btn'} type="button" onClick={() => { setSortKey('score'); setDirection('asc') }}>ASC</button>
        </>}
        {timeFilter && <>
          <input aria-label="起始时间" value={from} placeholder="From" onChange={event => setFrom(event.target.value)} />
          <input aria-label="结束时间" value={to} placeholder="To" onChange={event => setTo(event.target.value)} />
        </>}
      </div>
      <label className="db-redis-key-search"><input aria-label="Keyword Search" placeholder="Keyword Search" value={keyword} onChange={event => setKeyword(event.target.value)} /></label>
    </div>
    {formError && <p className="db-redis-key-hint">{formError}</p>}
    <div className="db-redis-key-scroll">
      <table className="db-redis-key-grid">
        <thead><tr>
          {sequence && <th>ID ({total})</th>}
          {columns.map((column, index) => <th key={column.key} aria-sort={activeKey === column.key ? (activeDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
            <button type="button" onClick={() => toggleSort(column.key)}>{column.label}{!sequence && index === 0 ? ` (${total})` : ''}</button>
          </th>)}
          <th />
        </tr></thead>
        <tbody>
          {creating && drafts.map((draft, index) => <tr key={`new-${index}`}>
            {sequence && <td className="db-redis-key-id">…</td>}
            {formColumns.map(column => {
              const field = createFields.find(item => item.key === column.key)
              return <td key={column.key}>{field ? <input aria-label={field.label} placeholder={field.label} value={draft[field.key] ?? ''} onChange={event => setDrafts(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, [field.key]: event.target.value } : item))} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submitCreate() } if (event.key === 'Escape') setCreating(false) }} /> : null}</td>
            })}
            <td className="db-redis-key-actions">
              {repeatCreate && index === drafts.length - 1 && <button className="db-redis-btn" type="button" onClick={() => setDrafts(current => [...current, blank()])}>添加字段</button>}
              {index === 0 && <button className="db-redis-btn db-primary" type="button" disabled={writing} onClick={submitCreate}>添加</button>}
              {index === 0 && <button className="db-redis-btn" type="button" onClick={() => setCreating(false)}>取消</button>}
            </td>
          </tr>)}
          {shown.map(row => <tr key={row.id} onClick={() => startEdit(row)}>
            {sequence && <td className="db-redis-key-id">{row.id}</td>}
            {columns.map(column => {
              const field = createFields.find(item => item.key === column.key)
              const editingRow = editing === row.id && field
              return <td key={column.key} className={[wrapColumn === column.key ? 'db-redis-key-wrap' : '', editingRow ? 'is-editing' : ''].filter(Boolean).join(' ') || undefined} title={row.cells[column.key] ?? ''} onClick={event => { if (onCell) { event.stopPropagation(); onCell(column.key, row) } }}>
                <span className="db-redis-key-cell">{row.cells[column.key] ?? ''}</span>
                {editingRow && <input className="db-redis-key-editor" aria-label={field.label} placeholder={field.label} value={editValues[field.key] ?? ''} onClick={event => event.stopPropagation()} onChange={event => setEditValues(current => ({ ...current, [field.key]: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submitEdit(row) } if (event.key === 'Escape') setEditing(undefined) }} />}
              </td>
            })}
            <td className="db-redis-key-actions" onClick={event => event.stopPropagation()}>
              <button className="db-icon-button" type="button" aria-label="复制行" onClick={() => onCopy(rowCopyText(kind, row))}><Copy size={14} /></button>
              {allowEdit && <button className="db-icon-button" type="button" aria-label={editing === row.id ? '保存行' : '编辑行'} aria-pressed={editing === row.id} disabled={writing} onClick={() => editing === row.id ? submitEdit(row) : startEdit(row)}>{editing === row.id ? <Check size={14} /> : <Pencil size={14} />}</button>}
              {allowDelete && <button className="db-icon-button" type="button" aria-label={pendingDelete === row.id ? '确认删除' : '删除行'} disabled={writing} onClick={() => pendingDelete === row.id ? onDelete?.(row) : setPendingDelete(row.id)}>{pendingDelete === row.id ? '确认' : <Trash2 size={14} />}</button>}
              <button className="db-icon-button" type="button" aria-label="查看行" onClick={() => setPreview(current => current === rowPreview(row) ? '' : rowPreview(row))}><Eye size={14} /></button>
            </td>
          </tr>)}
          {!shown.length && !creating && <tr><td className="db-muted" colSpan={columns.length + (sequence ? 2 : 1)}>{keyword.trim() || from.trim() || to.trim() ? '没有匹配的行。' : '没有数据。'}</td></tr>}
        </tbody>
      </table>
    </div>
    {preview && <pre className="db-cell-detail db-redis-key-preview">{preview}</pre>}
  </>
}

import React, { useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { isCatalogView } from '../shared/workbench.ts'
import type { Connection } from '../shared/workbench.ts'
import type { SchemaCache } from './schema/schema-cache.ts'
import { FieldDetailPane } from './field-detail-pane.tsx'
import type { TreeFocus } from './tree-focus.ts'
import { useDragResize } from './workspace/parts/use-drag-resize.ts'

type ObjectKind = 'table' | 'view'

function formatBytes(value: unknown): string {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(value: unknown): string {
  if (!value) return ''
  const text = String(value)
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? text : date.toLocaleString()
}

export function ObjectHome({
  schema, folder, objects, busy, highlight, connection, cache, treeFocus, onHighlight, onOpen, onHint,
}: {
  schema: string
  folder: ObjectKind
  objects: Record<string, unknown>[]
  busy: boolean
  highlight: string
  connection: Connection
  cache: SchemaCache
  treeFocus?: TreeFocus
  onHighlight(name: string, kind: ObjectKind): void
  onOpen(name: string, kind: ObjectKind): void
  onHint(text: string): void
}) {
  const [query, setQuery] = useState('')
  const [detailWidth, setDetailWidth] = useState(260)
  const splitRef = useRef<HTMLDivElement>(null)
  const rows = objects.filter(item => folder === 'view' ? isCatalogView(item.kind) : !isCatalogView(item.kind))
    .filter(item => !query.trim() || String(item.name).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) || String(item.comment || '').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const selected = rows.find(item => String(item.name) === highlight)
  const startDetailResize = useDragResize((start, next) => {
    const max = Math.min(520, Math.max(280, (splitRef.current?.clientWidth || 800) * 0.55))
    setDetailWidth(Math.min(max, Math.max(200, detailWidth + (start.clientX - next.clientX))))
  })
  return <div className="db-object-home">
    <div className="db-catalog-tools">
      <strong>{schema || '未选择数据库'} · {folder === 'view' ? '视图' : '表'}</strong>
      <button className="db-primary" disabled={!selected} onClick={() => selected && onOpen(String(selected.name), folder)}>打开表</button>
      <button onClick={() => onHint('请使用 Navicat 导入/导出')}>导入向导</button>
      <button onClick={() => onHint('请使用 Navicat 导入/导出')}>导出向导</button>
      <div className="db-catalog-search"><Search size={15} /><input aria-label="搜索对象" placeholder="搜索" value={query} onChange={e => setQuery(e.target.value)} />{query && <button className="db-icon-button" aria-label="清空对象搜索" onClick={() => setQuery('')}><X size={12} /></button>}</div>
    </div>
    {busy && <p className="db-info-note" role="status">正在读取对象…</p>}
    <div className="db-object-home-split" ref={splitRef}>
      <div className="db-object-home-main">
      <div className="db-grid-scroll">
        <table className="db-grid db-object-list"><thead><tr>
          <th>名称</th><th>自动递增值</th><th>修改日期</th><th>数据长度</th><th>引擎</th><th>行</th><th>注释</th>
        </tr></thead><tbody>
          {rows.map(item => {
            const name = String(item.name)
            return <tr key={name} className={highlight === name ? 'is-active' : ''}
              onClick={() => onHighlight(name, folder)}
              onDoubleClick={() => onOpen(name, folder)}>
              <td><button className="db-text-button" onClick={() => onHighlight(name, folder)}>{name}</button></td>
              <td>{item.autoIncrement == null || item.autoIncrement === '' ? '' : String(item.autoIncrement)}</td>
              <td>{formatDate(item.updatedAt || item.createdAt)}</td>
              <td>{formatBytes(item.dataBytes)}</td>
              <td>{String(item.engine || item.tablespace || '')}</td>
              <td>{item.estimatedRows == null ? '' : String(item.estimatedRows)}</td>
              <td>{String(item.comment || '')}</td>
            </tr>
          })}
        </tbody></table>
        {!busy && !rows.length && <p className="db-info-note">没有匹配的{folder === 'view' ? '视图' : '表'}。</p>}
      </div>
      </div>
      <div className="db-object-home-resizer" role="separator" aria-orientation="vertical" aria-label="拖拽调整详情区宽度" onPointerDown={startDetailResize} />
      <div className="db-object-home-detail" style={{ width: detailWidth, flexShrink: 0 }}>
        <FieldDetailPane connection={connection} cache={cache} schema={schema} treeFocus={treeFocus} tableRecord={selected as Record<string, unknown> | undefined} />
      </div>
    </div>
  </div>
}

import {DrawerClose} from './workspace/parts/layout/drawer-chrome.tsx'
import {ResourceError} from './workspace/parts/feedback/resource-error.tsx'
import React, { useEffect, useRef, useState } from 'react'
import type { Connection } from '../shared/workbench.ts'
import { useDragResize } from './workspace/parts/hooks/use-drag-resize.ts'
import type { SchemaCache } from './schema/schema-cache.ts'

const PANE_DEFAULT = 340
const PANE_MIN = 180
const EDITOR_MIN = 160

function clampPaneWidth(width: number, rowWidth: number): number {
  if (rowWidth <= 0) return width
  // Nested workspaces can be narrower than the usual editor minimum. Keep
  // both the editor and the structure header (including Close) reachable.
  const editorMin = Math.min(EDITOR_MIN, Math.max(24, rowWidth - PANE_MIN))
  const max = Math.max(0, rowWidth - editorMin)
  const min = Math.min(PANE_MIN, max)
  return Math.min(max, Math.max(min, width))
}

function fieldLabel(column: Record<string, unknown>): string {
  const name = String(column.name ?? '')
  const comment = String(column.comment ?? '').trim()
  return comment ? `${name} (${comment})` : name
}

export function TableStructurePane({
  cache, connection, schema, table, onClose,
}: {
  cache: SchemaCache
  connection: Connection
  schema: string
  table: string
  onClose(): void
}) {
  const paneRef = useRef<HTMLDivElement>(null)
  const widthRef = useRef(PANE_DEFAULT)
  const origin = useRef(PANE_DEFAULT)
  const [width, setWidth] = useState(PANE_DEFAULT)
  const cached = cache.detailSnapshot(connection, schema, table)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(!cached)
  const applyWidth = (next: number) => {
    widthRef.current = next
    setWidth(next)
  }
  const onResize = useDragResize((start, next) => {
    const row = paneRef.current?.parentElement?.clientWidth || 0
    applyWidth(clampPaneWidth(origin.current + start.clientX - next.clientX, row))
  })
  useEffect(() => {
    const row = paneRef.current?.parentElement
    if (!row) return
    const clamp = () => {
      const next = clampPaneWidth(widthRef.current, row.clientWidth)
      if (next !== widthRef.current) applyWidth(next)
    }
    clamp()
    const observer = new ResizeObserver(clamp)
    observer.observe(row)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let alive = true
    setBusy(!cache.detailSnapshot(connection, schema, table))
    setError('')
    void cache.loadTable(connection, schema, table).catch(e => { if (alive) setError(e instanceof Error ? e.message : '无法读取结构') }).finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [cache, connection, schema, table])
  const detail = cache.detailSnapshot(connection, schema, table)
  return <div className="db-structure-pane" ref={paneRef} style={{ width }} aria-label={`${table} 表结构`}>
    <div className="db-structure-pane-resizer" role="separator" aria-orientation="vertical" aria-label="拖拽调整表结构宽度" onPointerDown={event => { origin.current = widthRef.current; onResize(event) }} />
    <div className="db-structure-pane-body">
      <h3>{table}<DrawerClose label="关闭表结构" close={onClose}/></h3>
      {busy && <p className="db-info-note" role="status">正在读取字段…</p>}
      {error && <ResourceError message={error}/>}
      {detail && <div className="db-grid-scroll"><table className="db-grid"><thead><tr><th>字段</th><th>类型</th><th>NULL</th><th>KEY</th><th>默认值</th><th>Extra</th></tr></thead>
        <tbody>{(detail.columns || []).map(column => <tr key={String(column.name)}>
          <td>{fieldLabel(column)}</td>
          <td>{String(column.type || '')}</td>
          <td>{String(column.nullable ?? '')}</td>
          <td>{String(column.key || column.columnKey || '')}</td>
          <td>{column.defaultValue === undefined || column.defaultValue === null ? 'NULL' : String(column.defaultValue)}</td>
          <td>{String(column.extra || '')}</td>
        </tr>)}</tbody></table></div>}
    </div>
  </div>
}

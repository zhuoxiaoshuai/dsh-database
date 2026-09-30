import React from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react'

export { SQL_PANE_GUTTER as PANE_GUTTER } from '../../sql-pane-layout.ts'

export function PaneGutter({
  axis,
  collapsed = false,
  collapsedEdge = 'start',
  onToggle,
  onCollapseStart,
  onCollapseEnd,
  onExpand,
  onResize,
  start,
}: {
  axis: 'x' | 'y'
  collapsed?: boolean
  collapsedEdge?: 'start' | 'end'
  onToggle?(): void
  onCollapseStart?(): void
  onCollapseEnd?(): void
  onExpand?(): void
  onResize?(event: React.PointerEvent): void
  start?: React.ReactNode
}): React.ReactElement {
  const vertical = axis === 'x'
  const split = !collapsed && !onToggle && !!(onCollapseStart && onCollapseEnd)
  const onRailDown = (event: React.PointerEvent) => {
    if (!onResize || collapsed) return
    if ((event.target as HTMLElement).closest('button')) return
    onResize(event)
  }
  return <div
    className={`db-pane-gutter db-pane-gutter-${vertical ? 'x' : 'y'}${collapsed ? ' is-collapsed' : ''}${onResize && !collapsed ? ' is-resizable' : ''}`}
    role="separator"
    aria-orientation={vertical ? 'vertical' : 'horizontal'}
    onPointerDown={onRailDown}
  >
    {start && <div className="db-pane-gutter-start">{start}</div>}
    <div className="db-pane-gutter-btns">
      {collapsed ? <button
        type="button"
        className="db-pane-gutter-btn"
        aria-label={vertical ? '展开面板' : collapsedEdge === 'start' ? '展开编辑器' : '展开结果'}
        onPointerDown={event => event.stopPropagation()}
        onClick={onExpand || onToggle}
      >
        {vertical ? <ChevronRight size={14} /> : collapsedEdge === 'start' ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button> : onToggle ? <button
        type="button"
        className="db-pane-gutter-btn"
        aria-label={vertical ? '折叠面板' : '折叠'}
        onPointerDown={event => event.stopPropagation()}
        onClick={onToggle}
      >
        {vertical ? <ChevronLeft size={14} /> : <ChevronUp size={14} />}
      </button> : split ? <>
        <button type="button" className="db-pane-gutter-btn" aria-label="收起编辑器" onPointerDown={event => event.stopPropagation()} onClick={onCollapseStart}><ChevronUp size={14} /></button>
        <button type="button" className="db-pane-gutter-btn" aria-label="收起结果" onPointerDown={event => event.stopPropagation()} onClick={onCollapseEnd}><ChevronDown size={14} /></button>
      </> : null}
    </div>
  </div>
}

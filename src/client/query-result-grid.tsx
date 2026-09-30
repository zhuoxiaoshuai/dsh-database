import React, { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CellDetailViewer, type CellDetailViewerHandle } from './cell-detail-viewer.tsx'
import { DataGrid, type CellPos, type DataGridHandle, type DataGridProps } from './data-grid.tsx'
import { GridCopyShell } from './grid-copy/shell.tsx'
import { GridSearchBar } from './grid-search/bar.tsx'
import { searchCells } from './grid-search/match.ts'
import { useDockSplit } from './dock-split-context.ts'
import { applyDockDrag, dockMaxHeight, DOCK_MIN_HEIGHT } from './query-detail-layout.ts'
import type { Dialect } from '../shared/workbench.ts'

export type QueryResultGridProps = Omit<DataGridProps, 'onDetailEdit'> & {
  detailColumn?: string
  detailValue: string | null | undefined
  detailEditable?: boolean
  onDetailApply?(value: string | null): void
  onDetailEdit?(pos: { row: number; col: number }): void
  dialect?: Dialect
  schema?: string
  table?: string
  columnTypes?: string[]
  extraMenu?: React.ReactNode | ((pos: CellPos) => React.ReactNode)
  onCopyError?(message: string): void
}

export const QueryResultGrid = forwardRef<DataGridHandle, QueryResultGridProps>(function QueryResultGrid({
  detailColumn,
  detailValue,
  detailEditable,
  onDetailApply,
  onDetailEdit,
  dialect,
  schema,
  table,
  columnTypes,
  extraMenu,
  onCopyError,
  ...grid
}, forwardedRef) {
  const root = useRef<HTMLDivElement>(null)
  const detail = useRef<CellDetailViewerHandle>(null)
  const pinToMax = useRef(true)
  const dragOrigin = useRef(0)
  const dragGrid = useRef(0)
  const stealPeak = useRef(0)
  const { beginSteal, stealEditor } = useDockSplit()
  const [expanded, setExpanded] = useState(false)
  const [height, setHeight] = useState(DOCK_MIN_HEIGHT)
  const [maxHeight, setMaxHeight] = useState(DOCK_MIN_HEIGHT)
  const searchInput = useRef<HTMLInputElement>(null)
  const onSelectRef = useRef(grid.onSelect)
  onSelectRef.current = grid.onSelect
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const seenResult = useRef(grid.result)
  if (seenResult.current !== grid.result) {
    seenResult.current = grid.result
    if (query) setQuery('')
    if (index) setIndex(0)
  }
  const hits = useMemo(() => searchCells({
    result: grid.result,
    draftRows: grid.draftRows,
    changed: grid.changed,
    primaryKeys: grid.primaryKeys,
    query,
  }), [grid.result, grid.draftRows, grid.changed, grid.primaryKeys, query])
  const safeIndex = hits.length ? Math.min(index, hits.length - 1) : 0
  const current = query.trim() && hits.length ? hits[safeIndex] : undefined
  const hitKey = current ? `${current.row}:${current.col}` : ''

  useLayoutEffect(() => {
    const frame = root.current?.closest('.db-query-result-frame')
    setSlot(frame?.querySelector<HTMLElement>('.db-query-result-search-slot') ?? null)
  }, [])

  useEffect(() => {
    const node = root.current
    if (!node) return
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f') return
      const target = event.target
      if (!(target instanceof Node) || !node.querySelector('.db-grid-scroll')?.contains(target)) return
      event.preventDefault()
      searchInput.current?.focus()
      searchInput.current?.select()
    }
    node.addEventListener('keydown', onKey)
    return () => node.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!hitKey) return
    const [row, col] = hitKey.split(':').map(Number)
    onSelectRef.current({ row, col })
    const cell = root.current?.querySelector(`td[data-row="${row}"][data-col="${col}"]`)
    if (cell instanceof HTMLElement) cell.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [hitKey, query])

  const step = (delta: number) => {
    if (!hits.length) return
    setIndex(value => {
      const base = Math.min(value, hits.length - 1)
      return (base + delta + hits.length) % hits.length
    })
  }
  const clearSearch = () => {
    setQuery('')
    setIndex(0)
    root.current?.querySelector<HTMLElement>('.db-grid-scroll')?.focus({ preventScroll: true })
  }

  useEffect(() => {
    const node = root.current
    if (!node) return
    const measure = () => {
      const next = dockMaxHeight(node.clientHeight)
      setMaxHeight(next)
      if (next < DOCK_MIN_HEIGHT) {
        setExpanded(false)
        return
      }
      setHeight(current => pinToMax.current ? next : Math.min(current, Math.max(DOCK_MIN_HEIGHT, next)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const fillDock = () => {
    const fill = dockMaxHeight(root.current?.clientHeight || 0)
    if (fill < DOCK_MIN_HEIGHT) return false
    pinToMax.current = true
    setMaxHeight(fill)
    setHeight(fill)
    setExpanded(true)
    return true
  }

  const openDetail = (pos: { row: number; col: number }) => {
    onDetailEdit?.(pos)
    if (!fillDock()) return
    queueMicrotask(() => detail.current?.focusEditor())
  }

  const onExpandedChange = (next: boolean) => {
    if (next) fillDock()
    else setExpanded(false)
  }

  const onResizeStart = () => {
    dragOrigin.current = height
    dragGrid.current = root.current?.clientHeight || 0
    stealPeak.current = 0
    beginSteal()
  }

  const onHeightChange = (desired: number) => {
    const result = applyDockDrag({
      startHeight: dragOrigin.current,
      startGridHeight: dragGrid.current,
      currentGridHeight: root.current?.clientHeight || 0,
      deltaY: desired - dragOrigin.current,
    })
    pinToMax.current = result.pinToMax
    if (result.stealPx > stealPeak.current) {
      stealPeak.current = result.stealPx
      stealEditor(result.stealPx)
    }
    setHeight(result.height)
  }

  return <div className="db-query-result-grid" ref={root}>
    {slot && createPortal(<GridSearchBar
      query={query}
      index={safeIndex}
      total={query.trim() ? hits.length : 0}
      inputRef={searchInput}
      onQuery={value => { setQuery(value); setIndex(0) }}
      onPrev={() => step(-1)}
      onNext={() => step(1)}
      onClear={clearSearch}
    />, slot)}
    <GridCopyShell result={grid.result} draftRows={grid.draftRows} changed={grid.changed} primaryKeys={grid.primaryKeys} selected={grid.selected} editing={grid.editing} dialect={dialect} schema={schema} table={table} columnTypes={columnTypes} extraMenu={extraMenu} onCopyError={onCopyError}>
      <DataGrid ref={forwardedRef} {...grid} matches={query.trim() ? hits : undefined} currentMatch={current} onDetailEdit={openDetail} />
    </GridCopyShell>
    <CellDetailViewer
      ref={detail}
      column={detailColumn}
      value={detailValue}
      editable={detailEditable}
      onApply={onDetailApply}
      expanded={expanded}
      height={height}
      maxHeight={maxHeight}
      onExpandedChange={onExpandedChange}
      onHeightChange={onHeightChange}
      onResizeStart={onResizeStart}
    />
  </div>
})

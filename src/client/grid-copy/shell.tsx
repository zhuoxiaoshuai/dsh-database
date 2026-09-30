import React, { cloneElement, useEffect, useRef, useState } from 'react'
import type { CellPos, CellRange, DataGridProps } from '../data-grid.tsx'
import { useDelayedClickDismiss } from '../workspace/parts/use-delayed-click-dismiss.ts'
import type { Dialect, Result } from '../../shared/workbench.ts'
import { cellsInRange, formatCsv, formatInsert, formatTsv, plainCell, rowsBetween, writeClipboard, type CopyRange, type CopyShape } from './format.ts'
import { GridCopyMenu, type CopyAction } from './menu.tsx'

export function GridCopyShell({
  children, result, draftRows, changed, primaryKeys, selected, editing, dialect = 'mysql', schema = '', table = '', columnTypes = [], extraMenu, onCopyError,
}: {
  children: React.ReactElement
  result: Result
  draftRows: DataGridProps['draftRows']
  changed: DataGridProps['changed']
  primaryKeys: string[]
  selected?: CellPos
  editing?: CellPos
  dialect?: Dialect
  schema?: string
  table?: string
  columnTypes?: string[]
  extraMenu?: React.ReactNode | ((pos: CellPos) => React.ReactNode)
  onCopyError?(message: string): void
}): React.ReactElement {
  const root = useRef<HTMLDivElement>(null)
  const anchor = useRef<CellPos | null>(null)
  const suppressClick = useRef(false)
  const [range, setRange] = useState<CellRange>()
  const [menu, setMenu] = useState<{ x: number; y: number; row: number; col: number }>()
  useDelayedClickDismiss(!!menu, () => setMenu(undefined))
  useEffect(() => { setRange(undefined); setMenu(undefined) }, [result])

  const focusGrid = () => root.current?.querySelector<HTMLElement>('.db-grid-scroll')?.focus({ preventScroll: true })
  const span = (): CopyRange | undefined => range || (selected ? { r1: selected.row, c1: selected.col, r2: selected.row, c2: selected.col } : undefined)

  const copyText = async (text: string) => {
    try { await writeClipboard(text) }
    catch { onCopyError?.('复制失败，请选中文字复制') }
  }

  const onPick = (action: CopyAction) => {
    if (!menu) return
    if (action === 'cell') {
      const selectedText = textInsideCell(root.current)
      if (selectedText) { void copyText(selectedText); return }
      const grid = cellsInRange(result, draftRows, changed, primaryKeys, { r1: menu.row, c1: menu.col, r2: menu.row, c2: menu.col }, columnTypes)
      void copyText(plainCell(grid.rows[0]?.[0] ?? null))
      return
    }
    if (action === 'field') { void copyText(result.columns[menu.col] || ''); return }
    const current = span() || { r1: menu.row, c1: menu.col, r2: menu.row, c2: menu.col }
    if (action === 'rows' || action === 'insert') {
      const grid = cellsInRange(result, draftRows, changed, primaryKeys, current, columnTypes, 'rows')
      void copyText(action === 'rows' ? formatTsv(grid.columns, grid.rows, 'values') : formatInsert(dialect, table, grid.columns, grid.rows, grid.types, schema))
      return
    }
    const grid = cellsInRange(result, draftRows, changed, primaryKeys, current, columnTypes)
    const shape: CopyShape = action.endsWith('fields') ? 'fields' : action.endsWith('both') ? 'both' : 'values'
    void copyText(action.startsWith('csv') ? formatCsv(grid.columns, grid.rows, shape, grid.types) : formatTsv(grid.columns, grid.rows, shape))
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'c') return
    if (editing) return
    const active = document.activeElement
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return
    const node = root.current
    if (!node || (active !== node && !node.contains(active))) return
    if (textInsideCell(node)) return
    const current = span()
    if (!current) return
    event.preventDefault()
    const grid = cellsInRange(result, draftRows, changed, primaryKeys, current, columnTypes)
    const single = grid.rows.length === 1 && grid.columns.length === 1
    void copyText(single ? plainCell(grid.rows[0][0]) : formatTsv(grid.columns, grid.rows, 'values'))
  }

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0 || editing) return
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
    const cell = cellFrom(event.target)
    if (!cell || cell.col < 0) return
    const start = { x: event.clientX, y: event.clientY, row: cell.row, col: cell.col, moved: false }
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 8) return
      const next = cellFrom(document.elementFromPoint(ev.clientX, ev.clientY), root.current)
      if (!next || next.col < 0 || (next.row === start.row && next.col === start.col)) return
      if (!start.moved) {
        start.moved = true
        window.getSelection()?.removeAllRanges()
        focusGrid()
      }
      setRange({ r1: start.row, c1: start.col, r2: next.row, c2: next.col })
    }
    const up = () => {
      if (start.moved) suppressClick.current = true
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const onClick = (event: React.MouseEvent) => {
    if (suppressClick.current) { suppressClick.current = false; return }
    const cell = cellFrom(event.target)
    if (!cell) return
    focusGrid()
    if (cell.col < 0) {
      anchor.current = { row: cell.row, col: 0 }
      setRange({ r1: cell.row, c1: 0, r2: cell.row, c2: Math.max(0, result.columns.length - 1) })
      return
    }
    if (event.shiftKey && anchor.current) {
      window.getSelection()?.removeAllRanges()
      setRange({ r1: anchor.current.row, c1: anchor.current.col, r2: cell.row, c2: cell.col })
      return
    }
    anchor.current = cell
    setRange({ r1: cell.row, c1: cell.col, r2: cell.row, c2: cell.col })
  }

  const onDoubleClick = (event: React.MouseEvent) => {
    const td = event.target instanceof Element ? event.target.closest('td[data-col]') : null
    if (!td) return
    window.setTimeout(() => {
      if (!td.isConnected || td.querySelector('input, textarea')) return
      const text = td.querySelector('.db-cell-text, .db-null')
      const selection = window.getSelection()
      if (!text || !selection) return
      const next = document.createRange()
      next.selectNodeContents(text)
      selection.removeAllRanges()
      selection.addRange(next)
    }, 0)
  }

  const openMenu = (event: React.MouseEvent, pos: CellPos) => {
    focusGrid()
    setMenu({ x: event.clientX, y: event.clientY, ...pos })
    setRange(current => current && covers(current, pos, draftRows.length, result.rows.length) ? current : { r1: pos.row, c1: pos.col, r2: pos.row, c2: pos.col })
    anchor.current = pos
  }

  return <div className="db-grid-copy" ref={root} onKeyDown={onKeyDown} onPointerDown={onPointerDown} onClick={onClick} onDoubleClick={onDoubleClick}>
    {cloneElement(children as React.ReactElement<{ range?: CellRange; onContext: DataGridProps['onContext'] }>, { range, onContext: openMenu })}
    {menu && <GridCopyMenu x={menu.x} y={menu.y} extra={typeof extraMenu === 'function' ? extraMenu(menu) : extraMenu} onPick={onPick} onClose={() => setMenu(undefined)} />}
  </div>
}

function covers(range: CellRange, pos: CellPos, draftCount: number, dataCount: number): boolean {
  const c1 = Math.min(range.c1, range.c2)
  const c2 = Math.max(range.c1, range.c2)
  return rowsBetween(range, draftCount, dataCount).includes(pos.row) && pos.col >= c1 && pos.col <= c2
}

function cellFrom(target: EventTarget | null, root?: HTMLElement | null): CellPos | null {
  const node = target instanceof Element ? target.closest('td[data-row]') : null
  if (!node || (root && !root.contains(node))) return null
  const row = Number(node.getAttribute('data-row'))
  if (!Number.isInteger(row)) return null
  const colAttr = node.getAttribute('data-col')
  if (colAttr == null) return { row, col: -1 }
  const col = Number(colAttr)
  return Number.isInteger(col) ? { row, col } : null
}

function textInsideCell(root: HTMLElement | null): string {
  const selection = window.getSelection()
  if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return ''
  const node = selection.anchorNode
  const el = node instanceof Element ? node : node?.parentElement
  if (!el || !root.contains(el) || !el.closest('td[data-row]')) return ''
  return selection.toString()
}

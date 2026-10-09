import React, { cloneElement, useEffect, useRef, useState } from 'react'
import type { CellPos, DataGridProps } from '../data-grid.tsx'
import type { Dialect, Result } from '../../shared/workbench.ts'
import { cellsInSelection, formatCommaList, formatInsert, formatTsv, plainCell, writeClipboard, type CopyShape } from './format.ts'
import { cellSelection, selectColumn, selectionContains, type GridSelection } from './selection.ts'
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
  const columnAnchor = useRef<number | null>(null)
  const endDrag = useRef<(() => void) | undefined>(undefined)
  const suppressClick = useRef(false)
  const suppressTimer = useRef<number | undefined>(undefined)
  const [dragging, setDragging] = useState(false)
  const [selection, setSelection] = useState<GridSelection | null>()
  const previous = useRef({ result, selected })
  const [menu, setMenu] = useState<{ x: number; y: number; row: number; col: number; header?: boolean }>()
  useEffect(() => {
    if (previous.current.result !== result) {
      setSelection(null); setMenu(undefined)
      anchor.current = null; columnAnchor.current = null; suppressClick.current = false
      window.clearTimeout(suppressTimer.current)
      endDrag.current?.()
    } else if (previous.current.selected !== selected && selected) {
      // A new externally focused search hit can start a selection after a reset.
      setSelection(current => current === null ? cellSelection(selected) : current)
    }
    previous.current = { result, selected }
  }, [result, selected])
  useEffect(() => () => { endDrag.current?.(); window.clearTimeout(suppressTimer.current) }, [])

  const focusGrid = () => root.current?.querySelector<HTMLElement>('.db-grid-scroll')?.focus({ preventScroll: true })
  const span = (): GridSelection | undefined => selection === null ? undefined : selection ?? (selected ? cellSelection(selected) : undefined)

  const copyText = async (text: string) => {
    try { await writeClipboard(text) }
    catch { onCopyError?.('复制失败，请选中文字复制') }
  }

  const onPick = (action: CopyAction) => {
    if (!menu) return
    if (action === 'cell' && !menu.header) {
      const selectedText = textInsideCell(root.current)
      if (selectedText) { void copyText(selectedText); return }
      const grid = cellsInSelection(result, draftRows, changed, primaryKeys, cellSelection(menu), columnTypes)
      void copyText(plainCell(grid.rows[0]?.[0] ?? null))
      return
    }
    if (action === 'field' && !menu.header) { void copyText(result.columns[menu.col] || ''); return }
    const current = span() || cellSelection(menu)
    if (action === 'rows' || action === 'insert') {
      const grid = cellsInSelection(result, draftRows, changed, primaryKeys, current, columnTypes, 'rows')
      void copyText(action === 'rows' ? formatTsv(grid.columns, grid.rows, 'values') : formatInsert(dialect, table, grid.columns, grid.rows, grid.types, schema))
      return
    }
    const grid = cellsInSelection(result, draftRows, changed, primaryKeys, current, columnTypes)
    const shape: CopyShape = action === 'field' || action.endsWith('fields') ? 'fields' : action.endsWith('both') ? 'both' : 'values'
    void copyText(action.startsWith('comma') ? formatCommaList(grid.columns, grid.rows, shape, grid.types) : formatTsv(grid.columns, grid.rows, shape))
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
    const grid = cellsInSelection(result, draftRows, changed, primaryKeys, current, columnTypes)
    if (!grid.columns.length) return
    const single = grid.rows.length === 1 && grid.columns.length === 1
    void copyText(single ? plainCell(grid.rows[0][0]) : formatTsv(grid.columns, grid.rows, 'values'))
  }

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0 || editing) return
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
    if (event.target instanceof Element && event.target.closest('.db-grid-column-sort')) return
    const column = columnFrom(event.target, root.current, true)
    const cell = cellFrom(event.target, root.current)
    if (column === null && (!cell || cell.col < 0)) return
    endDrag.current?.()
    window.clearTimeout(suppressTimer.current)
    suppressClick.current = false
    const start = { x: event.clientX, y: event.clientY, row: cell?.row ?? 0, col: column ?? cell!.col, header: column !== null, moved: false }
    const move = (ev: PointerEvent) => {
      if (!start.moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 8) return
      const target = document.elementFromPoint(ev.clientX, ev.clientY)
      const next = start.header ? { row: 0, col: columnFrom(target, root.current) ?? -1 } : cellFrom(target, root.current)
      if (!next || next.col < 0 || (!start.moved && next.row === start.row && next.col === start.col)) return
      if (!start.moved) {
        start.moved = true
        setDragging(true)
        setMenu(undefined)
        anchor.current = start.header ? null : { row: start.row, col: start.col }
        columnAnchor.current = start.header ? start.col : null
        focusGrid()
      }
      window.getSelection()?.removeAllRanges()
      if (ev.cancelable) ev.preventDefault()
      setSelection(start.header
        ? selectColumn(undefined, next.col, start.col, true, false)
        : { kind: 'range', r1: start.row, c1: start.col, r2: next.row, c2: next.col })
    }
    const up = (ev?: PointerEvent) => {
      if (start.moved) {
        setDragging(false)
        if (ev?.type === 'pointerup' && ev.target instanceof Node && root.current?.contains(ev.target)) {
          suppressClick.current = true
          // The click generated by this release must not replace the drag selection.
          suppressTimer.current = window.setTimeout(() => { suppressClick.current = false }, 0)
        }
      }
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      endDrag.current = undefined
    }
    endDrag.current = up
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const onClick = (event: React.MouseEvent) => {
    const cell = cellFrom(event.target)
    if (!cell) return
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
    focusGrid()
    columnAnchor.current = null
    if (cell.col < 0) {
      anchor.current = { row: cell.row, col: 0 }
      setSelection({ kind: 'range', r1: cell.row, c1: 0, r2: cell.row, c2: Math.max(0, result.columns.length - 1) })
      return
    }
    if (event.shiftKey && anchor.current) {
      window.getSelection()?.removeAllRanges()
      setSelection({ kind: 'range', r1: anchor.current.row, c1: anchor.current.col, r2: cell.row, c2: cell.col })
      return
    }
    anchor.current = cell
    setSelection(cellSelection(cell))
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
    setSelection(current => current?.kind === 'columns'
      ? current.columns.includes(pos.col) ? current : { kind: 'columns', columns: [pos.col] }
      : selectionContains(current ?? undefined, pos, draftRows.length, result.rows.length) ? current : cellSelection(pos))
    anchor.current = pos
  }

  const onColumnSelect = (event: React.MouseEvent, col: number) => {
    window.getSelection()?.removeAllRanges()
    focusGrid()
    const start = columnAnchor.current
    setSelection(current => selectColumn(current ?? undefined, col, start, event.shiftKey, event.ctrlKey || event.metaKey))
    if (!event.shiftKey || columnAnchor.current === null) columnAnchor.current = col
    anchor.current = null
  }

  const onColumnContext = (event: React.MouseEvent, col: number) => {
    focusGrid()
    setSelection(current => current?.kind === 'columns' && current.columns.includes(col) ? current : { kind: 'columns', columns: [col] })
    columnAnchor.current = col
    anchor.current = null
    setMenu({ x: event.clientX, y: event.clientY, row: 0, col, header: true })
  }

  return <div className={`db-grid-copy${dragging ? ' is-drag-selecting' : ''}`} ref={root} onKeyDown={onKeyDown} onPointerDown={onPointerDown}
    onClickCapture={event => { if (suppressClick.current) { suppressClick.current = false; event.stopPropagation() } }} onClick={onClick} onDoubleClick={onDoubleClick}>
    {cloneElement(children as React.ReactElement<Pick<DataGridProps, 'selection' | 'onContext' | 'onColumnSelect' | 'onColumnContext'>>, { selection: selection ?? undefined, onContext: openMenu, onColumnSelect, onColumnContext })}
    {menu && <GridCopyMenu x={menu.x} y={menu.y} anchor={root.current} header={menu.header} extra={menu.header ? undefined : typeof extraMenu === 'function' ? extraMenu(menu) : extraMenu} onPick={onPick} onClose={() => { setMenu(undefined); focusGrid() }} />}
  </div>
}

function columnFrom(target: EventTarget | null, root: HTMLElement | null, headerOnly = false): number | null {
  const node = target instanceof Element ? target.closest(headerOnly ? 'th[data-col]' : 'th[data-col], td[data-col]') : null
  if (!node || !root?.contains(node)) return null
  const col = Number(node.getAttribute('data-col'))
  return Number.isInteger(col) ? col : null
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

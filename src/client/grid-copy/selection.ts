export type CellPos = { row: number; col: number }
export type GridSelection =
  | { kind: 'range'; r1: number; c1: number; r2: number; c2: number }
  | { kind: 'columns'; columns: number[] }

export function cellSelection(pos: CellPos): GridSelection {
  return { kind: 'range', r1: pos.row, c1: pos.col, r2: pos.row, c2: pos.col }
}

export function selectColumn(current: GridSelection | undefined, col: number, anchor: number | null, extend: boolean, toggle: boolean): GridSelection {
  if (extend && anchor !== null) {
    const low = Math.min(anchor, col), high = Math.max(anchor, col)
    return { kind: 'columns', columns: Array.from({ length: high - low + 1 }, (_, i) => low + i) }
  }
  const columns = toggle && current?.kind === 'columns' ? current.columns : []
  return { kind: 'columns', columns: columns.includes(col) ? columns.filter(value => value !== col) : [...columns, col].sort((a, b) => a - b) }
}

/** Draft rows render as -1, -2, … above loaded data rows. */
function visualRow(row: number, draftCount: number, dataCount: number): number | null {
  if (!Number.isInteger(row)) return null
  if (row < 0) {
    const index = -row - 1
    return index < draftCount ? index : null
  }
  return row < dataCount ? draftCount + row : null
}

export function selectionContains(selection: GridSelection | undefined, pos: CellPos, draftCount: number, dataCount: number): boolean {
  if (!selection) return false
  const here = visualRow(pos.row, draftCount, dataCount)
  if (here === null) return false
  if (selection.kind === 'columns') return selection.columns.includes(pos.col)
  const start = visualRow(selection.r1, draftCount, dataCount), end = visualRow(selection.r2, draftCount, dataCount)
  return start !== null && end !== null && here >= Math.min(start, end) && here <= Math.max(start, end)
    && pos.col >= Math.min(selection.c1, selection.c2) && pos.col <= Math.max(selection.c1, selection.c2)
}

export function selectionRows(selection: GridSelection, draftCount: number, dataCount: number): number[] {
  let low = 0, high = draftCount + dataCount - 1
  if (selection.kind === 'columns' && !selection.columns.length) return []
  if (selection.kind === 'range') {
    const start = visualRow(selection.r1, draftCount, dataCount), end = visualRow(selection.r2, draftCount, dataCount)
    if (start === null || end === null) return []
    low = Math.min(start, end); high = Math.max(start, end)
  }
  return Array.from({ length: Math.max(0, high - low + 1) }, (_, i) => {
    const index = low + i
    return index < draftCount ? -(index + 1) : index - draftCount
  })
}

export function selectionColumns(selection: GridSelection, columnCount: number): number[] {
  return Array.from({ length: columnCount }, (_, i) => i).filter(col => selection.kind === 'columns'
    ? selection.columns.includes(col)
    : col >= Math.min(selection.c1, selection.c2) && col <= Math.max(selection.c1, selection.c2))
}

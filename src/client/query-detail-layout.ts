export const GRID_ROW_HEIGHT = 28
export const GRID_HEADER_HEIGHT = 28
export const GRID_VISIBLE_ROWS = 3
export const GRID_RESERVE = GRID_HEADER_HEIGHT + GRID_ROW_HEIGHT * GRID_VISIBLE_ROWS
export const DOCK_MIN_HEIGHT = 120

export function dockMaxHeight(gridRootHeight: number, reserve = GRID_RESERVE): number {
  return Math.max(0, gridRootHeight - reserve)
}

export function applyDockDrag({
  startHeight,
  startGridHeight,
  currentGridHeight,
  deltaY,
  dockMin = DOCK_MIN_HEIGHT,
  reserve = GRID_RESERVE,
}: {
  startHeight: number
  startGridHeight: number
  currentGridHeight?: number
  deltaY: number
  dockMin?: number
  reserve?: number
}): { height: number; stealPx: number; pinToMax: boolean } {
  const startMax = dockMaxHeight(startGridHeight, reserve)
  const currentMax = dockMaxHeight(currentGridHeight ?? startGridHeight, reserve)
  const desired = startHeight + deltaY
  if (desired <= startMax) {
    const height = Math.min(startMax, Math.max(dockMin, desired))
    return { height, stealPx: 0, pinToMax: desired >= startMax }
  }
  const height = Math.min(currentMax, Math.max(dockMin, desired))
  return { height, stealPx: desired - startMax, pinToMax: desired >= currentMax }
}

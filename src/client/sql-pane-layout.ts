export const SQL_PANE_GUTTER = 14
export const SQL_EDITOR_LINE = 22
export const SQL_EDITOR_MIN_LINES = 3
export const SQL_EDITOR_MIN = SQL_EDITOR_LINE * SQL_EDITOR_MIN_LINES
// Result header/footer + three visible grid rows + the minimum expanded detail dock.
export const SQL_RESULT_MIN = 296
export const SQL_SPLIT_RATIO_DEFAULT = 0.5

export function clampSplitRatio(
  ratio: number,
  availableHeight: number,
  editorMin = SQL_EDITOR_MIN,
  resultMin = SQL_RESULT_MIN,
): number {
  if (!Number.isFinite(ratio)) return SQL_SPLIT_RATIO_DEFAULT
  if (availableHeight <= 0) return Math.min(0.85, Math.max(0.15, ratio))
  if (availableHeight < editorMin + resultMin) return editorMin / (editorMin + resultMin)
  const minimum = editorMin / availableHeight
  const maximum = 1 - resultMin / availableHeight
  return Math.min(maximum, Math.max(minimum, ratio))
}

export function ratioAfterDrag(
  ratio: number,
  deltaY: number,
  splitHeight: number,
  gutter = SQL_PANE_GUTTER,
): number {
  const available = Math.max(0, splitHeight - gutter)
  if (!available) return ratio
  return clampSplitRatio(ratio + deltaY / available, available)
}

export function stealEditorPixels(ratio: number, splitHeight: number, pixels: number, gutter = SQL_PANE_GUTTER): { ratio: number; stolen: number } {
  if (pixels <= 0) return { ratio, stolen: 0 }
  const available = Math.max(0, splitHeight - gutter)
  if (!available) return { ratio, stolen: 0 }
  const before = available * clampSplitRatio(ratio, available)
  const next = ratioAfterDrag(ratio, -pixels, splitHeight, gutter)
  const after = available * clampSplitRatio(next, available)
  return { ratio: next, stolen: Math.max(0, before - after) }
}

export function splitGridRows(
  editorOpen: boolean,
  resultOpen: boolean,
  ratio: number,
  splitHeight: number,
  gutter = SQL_PANE_GUTTER,
): string {
  if (editorOpen && resultOpen) {
    if (splitHeight <= gutter) return `${ratio}fr ${gutter}px ${1 - ratio}fr`
    const available = Math.max(0, splitHeight - gutter)
    const safeRatio = clampSplitRatio(ratio, available)
    const editor = Math.round(available * safeRatio)
    return `${editor}px ${gutter}px minmax(0,1fr)`
  }
  if (editorOpen) return `minmax(0,1fr) ${gutter}px`
  if (resultOpen) return `${gutter}px minmax(0,1fr)`
  return `${gutter}px`
}

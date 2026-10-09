type Size = { width: number; height: number }
export type MenuPlacement = { left: number; top: number; flyLeft: number; flyTop: number; inline: boolean }

export function placeCopyMenu(x: number, y: number, main: Size, fly: Size | undefined, itemOffset: number, viewport: Size): MenuPlacement {
  const margin = 8, gap = 6
  const clamp = (value: number, size: number, limit: number) => Math.max(margin, Math.min(value, limit - margin - size))
  let left = clamp(x, main.width, viewport.width)
  const top = clamp(y, main.height, viewport.height)
  let flyLeft = left + main.width + gap
  const inline = !!fly && main.width + fly.width + gap > viewport.width - margin * 2
  if (fly && !inline && flyLeft + fly.width > viewport.width - margin) {
    if (left - gap - fly.width >= margin) flyLeft = left - gap - fly.width
    else {
      left = viewport.width - margin - main.width - gap - fly.width
      flyLeft = left + main.width + gap
    }
  }
  return { left, top, flyLeft, flyTop: clamp(top + itemOffset, fly?.height ?? 0, viewport.height), inline }
}

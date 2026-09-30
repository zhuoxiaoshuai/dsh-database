import { useCallback, useEffect, useRef } from 'react'
import type React from 'react'

type DragResize = (start: React.PointerEvent, current: PointerEvent) => void

export function useDragResize(onMove: DragResize): (event: React.PointerEvent) => void {
  const onMoveRef = useRef(onMove)
  const cleanupRef = useRef<() => void>(() => {})
  onMoveRef.current = onMove

  useEffect(() => () => cleanupRef.current(), [])

  return useCallback((event: React.PointerEvent) => {
    event.preventDefault()
    cleanupRef.current()
    const start = event
    const onDrag = onMoveRef.current
    const move = (current: PointerEvent) => onDrag(start, current)
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', cleanup)
    }
    cleanupRef.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', cleanup)
  }, [])
}

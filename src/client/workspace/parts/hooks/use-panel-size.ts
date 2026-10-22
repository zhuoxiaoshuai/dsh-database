import { useLayoutEffect, useState, type RefObject } from 'react'

export function usePanelSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const measure = () => setSize(previous => {
      const next = { width: node.clientWidth, height: node.clientHeight }
      return previous.width === next.width && previous.height === next.height ? previous : next
    })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])
  return size
}

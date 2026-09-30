import { useEffect, useRef } from 'react'

export function useDelayedClickDismiss(enabled: boolean, dismiss: () => void): void {
  const dismissRef = useRef(dismiss)
  dismissRef.current = dismiss

  useEffect(() => {
    if (!enabled) return
    const close = () => dismissRef.current()
    const timer = window.setTimeout(() => window.addEventListener('click', close), 0)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('click', close)
    }
  }, [enabled])
}

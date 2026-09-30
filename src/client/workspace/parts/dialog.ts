import { useEffect, useRef, type MouseEvent, type RefObject } from 'react'

/** Close only when press and release both hit the dimmed backdrop, not a text-select drag that ends outside the dialog. */
export function shouldDismissBackdrop(pointerDownOnBackdrop: boolean, target: EventTarget | null, backdrop: EventTarget | null): boolean {
  return pointerDownOnBackdrop && !!backdrop && target === backdrop
}

export function useBackdropDismiss(close: () => void) {
  const started = useRef(false)
  const latestClose = useRef(close)
  latestClose.current = close
  return {
    onMouseDown(event: MouseEvent<HTMLElement>) {
      started.current = event.target === event.currentTarget
    },
    onClick(event: MouseEvent<HTMLElement>) {
      const hit = shouldDismissBackdrop(started.current, event.target, event.currentTarget)
      started.current = false
      if (hit) latestClose.current()
    },
  }
}

/** Scope keyboard handling to this dialog; never trap focus in the host document. */
export function useDialog(ref: RefObject<HTMLElement>, close: () => void, active = true) {
  const latestClose = useRef(close)
  latestClose.current = close
  useEffect(() => {
    const node = ref.current
    if (!node || !active) return
    const previous = document.activeElement as HTMLElement | null
    const controls = () => [...node.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')]
    controls()[0]?.focus()
    const keyboard = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); latestClose.current() }
      if (e.key !== 'Tab') return
      const items = controls(), first = items[0], last = items.at(-1)
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
    }
    node.addEventListener('keydown', keyboard)
    return () => { node.removeEventListener('keydown', keyboard); previous?.focus() }
  }, [ref, active])
}

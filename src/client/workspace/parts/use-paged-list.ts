import { useCallback, useEffect, useRef, useState } from 'react'

export type PagedPage<T> = { items: T[]; nextCursor?: string }
export type PagedLoad<T> = (cursor: string | undefined, signal: AbortSignal) => Promise<PagedPage<T>>

/** Paging lifecycle only. Callers own what a page means and must not rely on this hook to dedupe. */
export function usePagedList<T>(load: PagedLoad<T>) {
  const loadRef = useRef(load)
  loadRef.current = load
  const generation = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const nextCursorRef = useRef<string | undefined>(undefined)
  const [items, setItems] = useState<T[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const run = useCallback(async (mode: 'replace' | 'append', cursor: string | undefined) => {
    const current = ++generation.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    setError('')
    try {
      const page = await loadRef.current(cursor, controller.signal)
      if (current !== generation.current || controller.signal.aborted) return false
      setItems(previous => mode === 'append' ? [...previous, ...page.items] : page.items)
      nextCursorRef.current = page.nextCursor
      setNextCursor(page.nextCursor)
      return true
    } catch (caught) {
      if (current !== generation.current || controller.signal.aborted) return false
      if (caught instanceof DOMException && caught.name === 'AbortError') return false
      setError(caught instanceof Error ? caught.message : '加载失败。')
      return false
    } finally {
      if (current === generation.current) {
        setLoading(false)
        if (abortRef.current === controller) abortRef.current = null
      }
    }
  }, [])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    generation.current += 1
    nextCursorRef.current = undefined
    setItems([])
    setNextCursor(undefined)
    setError('')
    setLoading(false)
  }, [])

  const replace = useCallback(() => run('replace', undefined), [run])
  const append = useCallback(() => {
    const cursor = nextCursorRef.current
    if (cursor === undefined) return Promise.resolve(false)
    return run('append', cursor)
  }, [run])

  useEffect(() => () => {
    abortRef.current?.abort()
    generation.current += 1
  }, [])

  return { items, nextCursor, loading, error, reset, replace, append }
}

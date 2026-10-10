import { createRequestScope } from './request-scope.ts'
import { useCallback, useEffect, useRef, useState } from 'react'

export type PagedPage<T> = { items: T[]; nextCursor?: string }
export type PagedLoad<T> = (cursor: string | undefined, signal: AbortSignal) => Promise<PagedPage<T>>

/** Paging lifecycle only. Callers own what a page means and must not rely on this hook to dedupe. */
export function usePagedList<T>(load: PagedLoad<T>, identity = '') {
  const loadRef = useRef(load)
  loadRef.current = load
  const scope = useRef(createRequestScope(identity))
  const identityRef = useRef(identity)
  if (identityRef.current !== identity) {scope.current.invalidate(identity);identityRef.current = identity}
  const nextCursorRef = useRef<string | undefined>(undefined)
  const [items, setItems] = useState<T[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const run = useCallback(async (mode: 'replace' | 'append', cursor: string | undefined) => {
    const ticket = scope.current.latest('page')
    setLoading(true)
    setError('')
    try {
      const page = await loadRef.current(cursor, ticket.signal)
      if (!scope.current.isCurrent(ticket)) return false
      setItems(previous => mode === 'append' ? [...previous, ...page.items] : page.items)
      nextCursorRef.current = page.nextCursor
      setNextCursor(page.nextCursor)
      return true
    } catch (caught) {
      if (!scope.current.isCurrent(ticket)) return false
      if (caught instanceof DOMException && caught.name === 'AbortError') return false
      setError(caught instanceof Error ? caught.message : '加载失败。')
      return false
    } finally {
      if (scope.current.isCurrent(ticket)) {
        setLoading(false)

      }
      scope.current.finish(ticket)
    }
  }, [])

  const reset = useCallback(() => {
    scope.current.invalidate(identityRef.current)
    nextCursorRef.current = undefined
    setItems([])
    setNextCursor(undefined)
    setError('')
    setLoading(false)
  }, [])

  useEffect(() => { reset() }, [identity, reset])

  const replace = useCallback(() => run('replace', undefined), [run])
  const append = useCallback(() => {
    const cursor = nextCursorRef.current
    if (cursor === undefined) return Promise.resolve(false)
    return run('append', cursor)
  }, [run])

  useEffect(() => () => {
    scope.current.invalidate(identityRef.current)
  }, [])

  return { items, nextCursor, loading, error, reset, replace, append }
}

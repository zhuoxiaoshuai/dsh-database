import { useEffect, useRef, useState } from 'react'
import type { Connection, SharedQuery, WorkspaceBridge } from '../shared/workbench.ts'
import { applyExecutionResult, applyQueryChanged, displayFromLatest, displayMatchingEditor, hydrateSharedQuery, keepHydratedDisplay } from '../shared/query-sync.ts'
import { inferExecutionType, type DisplayResult, type ExecutionRecord, type WorkbenchEvent } from '../shared/execution.ts'

export function useExecutionItems(
  bridge: WorkspaceBridge | undefined,
  onPage?: (page: { items: ExecutionRecord[]; events?: WorkbenchEvent[]; gap?: boolean }) => void,
  onError?: () => void,
): { items: ExecutionRecord[]; error: string } {
  const [items, setItems] = useState<ExecutionRecord[]>([])
  const [error, setError] = useState('')
  const onPageRef = useRef(onPage)
  onPageRef.current = onPage
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  useEffect(() => {
    if (!bridge?.executions) return
    let alive = true
    let seen = 0
    const controller = new AbortController()
    const pull = async () => {
      while (alive) {
        try {
          const page = await bridge.executions!('execution-wait', { revision: seen }, controller.signal) as { revision: number; items: ExecutionRecord[]; events?: WorkbenchEvent[]; gap?: boolean }
          if (!alive) return
          seen = page.revision || 0
          setItems(page.items || [])
          setError('')
          onPageRef.current?.(page)
        } catch (e) {
          if (!alive || controller.signal.aborted) return
          setError(e instanceof Error ? e.message : '无法读取 AI 执行记录。')
          onErrorRef.current?.()
          await new Promise(resolve => setTimeout(resolve, 1500))
        }
      }
    }
    void pull()
    return () => { alive = false; controller.abort() }
  }, [bridge])
  return { items, error }
}

export function useAiQueryBus({
  bridge, connection, query, onQuery,
}: {
  bridge: WorkspaceBridge
  connection?: Connection
  query: SharedQuery
  onQuery(next: SharedQuery): void
}): {
  items: ExecutionRecord[]
  display?: DisplayResult
  setDisplay(next?: DisplayResult): void
  peer?: { connectionId: string; name?: string; status: string; executionId?: string }
  markEditing(value: boolean): void
  hydrate(): Promise<void>
  error: string
  dismissPeer(): void
} {
  const [display, setDisplay] = useState<DisplayResult>()
  const [peer, setPeer] = useState<{ connectionId: string; name?: string; status: string; executionId?: string }>()
  const queryRef = useRef(query)
  queryRef.current = query
  const displayRef = useRef(display)
  displayRef.current = display
  const editing = useRef(false)
  const connectionId = connection?.id
  const generation = connection?.generation
  const hydrateKey = `${connectionId || ''}\0${generation || ''}`
  const currentHydrateKey = useRef(hydrateKey)
  currentHydrateKey.current = hydrateKey
  const hydrateRef = useRef<{ key: string; promise: Promise<void> }>()

  const applyEvents = (events: WorkbenchEvent[], listed: ExecutionRecord[] = []) => {
    if (!connectionId) return
    let nextQuery = queryRef.current
    let nextDisplay = displayRef.current
    for (const event of events) {
      const merged = applyQueryChanged(nextQuery, event, { connectionId, localEditing: editing.current })
      if (merged) {
        nextQuery = merged
        nextDisplay = displayMatchingEditor(nextDisplay, nextQuery.sql)
      }
      nextDisplay = applyExecutionResult(nextDisplay, event, {
        connectionId, controller: nextQuery.controller, sql: nextQuery.sql, queryRevision: nextQuery.revision,
      })
      if (event.connectionId && event.connectionId !== connectionId && (event.type === 'EXECUTION_STARTED' || event.type === 'EXECUTION_FINISHED' || event.type === 'EXECUTION_FAILED')) {
        setPeer({
          connectionId: event.connectionId,
          name: listed.find(item => item.connectionId === event.connectionId)?.connectionName,
          status: event.type === 'EXECUTION_STARTED' ? 'running' : 'done',
          executionId: event.executionId,
        })
      }
    }
    if (nextQuery !== queryRef.current) onQuery(nextQuery)
    if (nextDisplay !== displayRef.current) setDisplay(nextDisplay)
  }

  const hydrate = (): Promise<void> => {
    if (!bridge.executions || !connectionId || !connection?.live) return Promise.resolve()
    if (hydrateRef.current?.key === hydrateKey) return hydrateRef.current.promise
    const key = hydrateKey
    const promise = (async () => {
      try {
        const body = await bridge.executions!('shared-query-get', { id: connectionId }) as { sharedQuery?: SharedQuery }
        if (currentHydrateKey.current !== key) return
        const editorQuery = body.sharedQuery
          ? hydrateSharedQuery(queryRef.current, body.sharedQuery, { connectionId, localEditing: editing.current })
          : queryRef.current
        if (editorQuery !== queryRef.current) onQuery(editorQuery)
        const latest = await bridge.executions!('execution-latest', { id: connectionId }) as { execution?: ExecutionRecord & { result?: DisplayResult['result']; generation?: string; type?: string } }
        if (currentHydrateKey.current !== key) return
        const next = displayFromLatest(connectionId, editorQuery, latest.execution, generation)
        if (!editing.current) {
          const kept = keepHydratedDisplay(displayRef.current, next, editorQuery.sql)
          if (kept !== displayRef.current) setDisplay(kept)
        }
      } catch { /* hydrate is best-effort */ }
    })().finally(() => {
      if (hydrateRef.current?.promise === promise) hydrateRef.current = undefined
    })
    hydrateRef.current = { key, promise }
    return promise
  }

  const { items, error } = useExecutionItems(bridge, page => {
    if (page.events?.length) applyEvents(page.events, page.items || [])
    if (page.gap) void hydrate()
  }, () => { void hydrate() })

  useEffect(() => {
    setDisplay(undefined)
    setPeer(undefined)
    editing.current = false
    void hydrate()
  }, [bridge, connectionId, generation, connection?.live])

  useEffect(() => {
    if (peer && peer.connectionId === connectionId) setPeer(undefined)
  }, [connectionId, peer])

  useEffect(() => {
    if (!peer || peer.status !== 'done') return
    const timer = setTimeout(() => setPeer(undefined), 8000)
    return () => clearTimeout(timer)
  }, [peer?.connectionId, peer?.executionId, peer?.status])

  return {
    items,
    display,
    setDisplay,
    peer,
    dismissPeer: () => setPeer(undefined),
    markEditing: value => { editing.current = value },
    hydrate,
    error,
  }
}

export { historyItemsForConnection } from '../shared/execution.ts'

export function activeExecution(items: ExecutionRecord[], connectionId?: string): ExecutionRecord | undefined {
  return items.find(item => {
    if (connectionId && item.connectionId !== connectionId) return false
    if (item.status !== 'preparing' && item.status !== 'checking' && item.status !== 'running') return false
    const type = item.type || inferExecutionType(item.operation)
    return type !== 'verify' && type !== 'catalog' && type !== 'tool'
  })
}

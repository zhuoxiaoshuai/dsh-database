import { useEffect, useRef, useState } from 'react'
import type { Connection, WorkspaceBridge, WorkspaceStorageStatus } from '../shared/workbench.ts'
import { sameDocumentResultTarget, documentResult, ownsDocumentResult, preferLiveGrid, sqlDisplay } from '../shared/query-sync.ts'
import type { ExecutionDocument } from '../shared/execution-document.ts'
import { inferExecutionType, type DocumentExecutionResult, type DisplayResult, type ExecutionRecord, type WorkbenchEvent } from '../shared/execution.ts'

type ExecutionPage = { revision?: number; items: ExecutionRecord[]; events?: WorkbenchEvent[]; gap?: boolean; storage?: WorkspaceStorageStatus }
type ExecutionListener = (page: ExecutionPage, error: string) => void
const subscriptions = new WeakMap<WorkspaceBridge, { listeners: Set<ExecutionListener>; controller: AbortController; page: ExecutionPage }>()
export function useExecutionItems(bridge: WorkspaceBridge | undefined, onPage?: (page: ExecutionPage) => void, onError?: () => void): { items: ExecutionRecord[]; error: string; storage?: WorkspaceStorageStatus } {
  const [storage, setStorage] = useState<WorkspaceStorageStatus>()
  const [items, setItems] = useState<ExecutionRecord[]>([])
  const [error, setError] = useState('')
  const callback = useRef({ onPage, onError })
  callback.current = { onPage, onError }
  useEffect(() => {
    if (!bridge?.executions) return
    let hub = subscriptions.get(bridge)
    const listener: ExecutionListener = (page, failure) => {
      setItems(page.items || []); setError(failure)
      if (!failure) setStorage(page.storage)
      if (failure) callback.current.onError?.()
      else callback.current.onPage?.(page)
    }
    if (!hub) {
      hub = { listeners: new Set(), controller: new AbortController(), page: { items: [] } }
      subscriptions.set(bridge, hub)
      const shared = hub
      void (async () => {
        let seen = 0
        while (!shared.controller.signal.aborted) {
          try {
            const page = await bridge.executions!('execution-wait', { revision: seen }, shared.controller.signal) as ExecutionPage
            if (shared.controller.signal.aborted) return
            seen = page.revision || 0; shared.page = page
            for (const receive of shared.listeners) receive(page, '')
          } catch (caught) {
            if (shared.controller.signal.aborted) return
            for (const receive of shared.listeners) receive(shared.page, caught instanceof Error ? caught.message : '无法读取执行记录。')
            await new Promise(resolve => setTimeout(resolve, 1500))
          }
        }
      })()
    }
    hub.listeners.add(listener)
    listener({ ...hub.page, events: [], gap: false }, '')
    const shared = hub
    return () => {
      shared.listeners.delete(listener)
      if (!shared.listeners.size) { shared.controller.abort(); subscriptions.delete(bridge) }
    }
  }, [bridge])
  return { items, error, storage }
}
/** One owner for current coediting results across all sources. */
export function useDocumentResultBus({ bridge, connection, document, unsaved = false, conversationId = bridge.conversationId }: {
  bridge: WorkspaceBridge; connection?: Connection; document: ExecutionDocument; unsaved?: boolean; conversationId?: string
}) {
  const [current, setCurrent] = useState<DocumentExecutionResult>()
  const [peer, setPeer] = useState<{ connectionId: string; name?: string; status: string; executionId?: string }>()
  const owner = { connectionId: connection?.id || '', generation: connection?.generation, conversationId, document, unsaved }
  const ownerRef = useRef(owner); ownerRef.current = owner
  const currentRef = useRef(current)
  const visible = current && sameDocumentResultTarget(current.identity, owner) ? current : undefined
  const stale = !!visible && !ownsDocumentResult(visible.identity, owner)
  currentRef.current = visible
  const key = JSON.stringify([owner.connectionId, owner.generation, conversationId, document, unsaved])
  const keyRef = useRef(key); keyRef.current = key
  const recovering = useRef<{ key: string; promise: Promise<void> }>()
  const accepted = useRef(0)
  const accept = (value: unknown) => {
    const incoming = documentResult(value)
    if (!incoming || !ownsDocumentResult(incoming.identity, ownerRef.current)) return
    const oldSql = sqlDisplay(currentRef.current), nextSql = sqlDisplay(incoming)
    const next = oldSql && nextSql ? { ...incoming, result: preferLiveGrid(oldSql, nextSql).result } : incoming
    ++accepted.current
    currentRef.current = next; setCurrent(next)
  }
  const hydrate = (): Promise<void> => {
    if (!bridge.executions || !connection?.live || !connection.id || ownerRef.current.unsaved) return Promise.resolve()
    const requestKey = keyRef.current
    const acceptance = accepted.current
    if (recovering.current?.key === requestKey) return recovering.current.promise
    const promise = (async () => {
      try {
        const latest = await bridge.executions!('execution-latest', { id: connection.id }) as { execution?: ExecutionRecord & { result?: unknown } }
        if (keyRef.current !== requestKey || accepted.current !== acceptance) return
        const record = latest.execution
        if (record) accept({ identity: record.identity, executionId: record.executionId, result: record.result, kind: record.type, message: record.message })
      } catch { /* recovery remains best effort */ }
    })().finally(() => { if (recovering.current?.promise === promise) recovering.current = undefined })
    recovering.current = { key: requestKey, promise }; return promise
  }
  const { items, error } = useExecutionItems(bridge, page => {
    for (const event of page.events || []) {
      if (event.type === 'EXECUTION_FINISHED' || event.type === 'EXECUTION_FAILED') {
        const failure = event.type === 'EXECUTION_FAILED'
        const payload = event.sourceResult ?? event.result ?? (failure && event.identity
          ? { columns: [], rows: [], elapsedMs: 0, truncated: false, message: event.message } : undefined)
        accept({ identity: event.identity, executionId: event.executionId, result: payload, kind: event.kind, message: event.message })
      }
      if (event.connectionId && event.connectionId !== ownerRef.current.connectionId && ['EXECUTION_STARTED', 'EXECUTION_FINISHED', 'EXECUTION_FAILED'].includes(event.type)) {
        setPeer({ connectionId: event.connectionId, name: page.items.find(item => item.connectionId === event.connectionId)?.connectionName,
          executionId: event.executionId, status: event.type === 'EXECUTION_STARTED' ? 'running' : 'done' })
      }
    }
    if (page.gap) void hydrate()
  }, () => { void hydrate() })
  useEffect(() => {
    if (current && !sameDocumentResultTarget(current.identity, ownerRef.current)) setCurrent(undefined)
    if (!unsaved) void hydrate()
  }, [key])
  useEffect(() => { setPeer(undefined) }, [connection?.id, connection?.generation])
  useEffect(() => {
    if (!peer || peer.status !== 'done') return
    const timer = setTimeout(() => setPeer(undefined), 8000)
    return () => clearTimeout(timer)
  }, [peer?.connectionId, peer?.executionId, peer?.status])
  return { items, current: visible, stale, display: sqlDisplay(visible), accept, hydrate, peer, error, dismissPeer: () => setPeer(undefined) }
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

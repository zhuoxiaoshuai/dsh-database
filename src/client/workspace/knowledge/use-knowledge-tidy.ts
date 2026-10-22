import { useEffect, useRef, useState } from 'react'
import type { Connection, WorkspaceBridge } from '../../../shared/workbench.ts'
import type { KnowledgeTidyBatch, KnowledgeTidyChange } from '../../../shared/knowledge.ts'
import { createRequestScope } from '../parts/request-scope.ts'

export type KnowledgeTidyController = {
  changes: KnowledgeTidyChange[]
  selectedId: string
  busy: boolean
  error: string
  notice: string
  select(id: string): void
  approve(id?: string): void
  reject(id?: string): void
}

type TidyResult = { tidy?: KnowledgeTidyBatch | null; applied?: string[]; failed?: { id: string; message: string }[]; remaining?: number }

export function useKnowledgeTidy(bridge: WorkspaceBridge, connection: Pick<Connection, 'id' | 'generation'> | undefined, active: boolean,
  mode: 'template' | 'knowledge', onChanged: () => void): KnowledgeTidyController {
  const [batch, setBatch] = useState<KnowledgeTidyBatch | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const connectionId = connection?.id || ''
  const generation = connection?.generation || ''
  const identity = `${mode}\0${connectionId}\0${generation}`
  const scope = useRef(createRequestScope(identity))
  const decision = useRef<object>()
  const readSequence = useRef(0)
  const identityRef = useRef(identity)
  if (identityRef.current !== identity) { scope.current.invalidate(identity); identityRef.current = identity }
  const changed = useRef(onChanged)
  changed.current = onChanged
  const prefix = mode === 'template' ? 'template-tidy' : 'knowledge-tidy'
  useEffect(() => {
    scope.current = createRequestScope(identity)
    decision.current = undefined; ++readSequence.current
    setBatch(null); setSelectedId(''); setError(''); setNotice(''); setBusy(false)
    return () => { if (identityRef.current === identity) scope.current.dispose() }
  }, [identity])
  const refresh = async (selected = '') => {
    if (!connectionId || !bridge.templates) return
    const sequence = ++readSequence.current
    const ticket = scope.current.latest('tidy')
    try {
      const next = await bridge.templates(`${prefix}-get`, { connectionId, ...(generation ? { generation } : {}) }, ticket.signal) as TidyResult
      if (!scope.current.isCurrent(ticket) || sequence !== readSequence.current) return
      setBatch(next.tidy || null)
      setSelectedId(next.tidy?.changes.some(change => change.id === selected) ? selected : '')
    } catch (caught) {
      if (scope.current.isCurrent(ticket) && sequence === readSequence.current) throw caught
    } finally { scope.current.finish(ticket) }
  }
  useEffect(() => {
    if (!active || decision.current) return
    void refresh().catch(caught => setError(caught instanceof Error ? caught.message : '读取待审批失败。'))
  }, [active, bridge, connectionId, generation, identity, prefix])
  const decide = (kind: 'apply' | 'reject', id?: string) => {
    if (!bridge.templates || decision.current || !connectionId || !batch) return
    const request = {}; decision.current = request; ++readSequence.current
    const ticket = scope.current.begin()
    setBusy(true); setError(''); setNotice('')
    const ids = id ? [id] : undefined
    let committed = false
    void bridge.templates(`${prefix}-${kind}`, { connectionId, batchId: batch.id, ...(generation ? { generation } : {}), ...(ids ? { ids } : {}) }, ticket.signal)
      .then(async body => {
        if (!scope.current.isCurrent(ticket)) return
        const result = body as TidyResult
        committed = true
        const failed = result.failed || []
        const applied = result.applied || []
        if (kind === 'apply') {
          setNotice(applied.length ? `已通过 ${applied.length} 条。` : '')
          setError(failed.map(item => item.message).filter(Boolean).join('\n'))
          if (applied.length) changed.current()
        } else setNotice('已驳回。')
        const consumed = new Set(kind === 'apply' ? applied : ids || batch.changes.map(change => change.id))
        setBatch(current => {
          if (!current || current.id !== batch.id) return current
          const changes = current.changes.filter(change => !consumed.has(change.id))
          return changes.length ? { ...current, changes } : null
        })
        // Invalidate reads issued before or during the decision, including activation reads.
        await refresh(id)
      })
      .catch(async caught => {
        if (!scope.current.isCurrent(ticket)) return
        setError(`${committed ? '审批已完成；待审批刷新失败：' : ''}${caught instanceof Error ? caught.message : '审批失败。'}`)
        // A replacement proposal must be shown before the user can decide again.
        try {
          await refresh()
        } catch { /* retain the original error if refreshing also fails */ }
      })
      .finally(() => { if (scope.current.isCurrent(ticket) && decision.current === request) { decision.current = undefined; setBusy(false) }; scope.current.finish(ticket) })
  }
  return {
    changes: batch?.changes || [],
    selectedId,
    busy,
    error,
    notice,
    select: setSelectedId,
    approve: id => decide('apply', id),
    reject: id => decide('reject', id),
  }
}

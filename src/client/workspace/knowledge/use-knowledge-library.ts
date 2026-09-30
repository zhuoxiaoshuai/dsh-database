import { useEffect, useRef, useState } from 'react'
import type { Connection, WorkspaceBridge } from '../../../shared/workbench.ts'
import type { KnowledgeItem } from '../../../shared/knowledge.ts'
import { createRequestScope } from '../parts/request-scope.ts'

export function useKnowledgeLibrary(bridge: WorkspaceBridge, connection: Connection, active: boolean,
  runText: (text: string, signal?: AbortSignal) => Promise<unknown>, useForQuery: (text: string) => void, executionContextKey = '') {
  const [items, setItems] = useState<KnowledgeItem[]>([])
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [tags, setTags] = useState('')
  const [result, setResult] = useState<unknown>()
  const [error, setError] = useState('')
  const [runError, setRunError] = useState('')
  const [busy, setBusy] = useState(false)
  const connectionIdentity = `${connection.id}\0${connection.generation || ''}`
  const identity = `${connectionIdentity}\0${executionContextKey}`
  const previousConnection = useRef(connectionIdentity)
  const identityRef = useRef(identity)
  const scope = useRef(createRequestScope(identity))
  if (identityRef.current !== identity) { scope.current.invalidate(identity); identityRef.current = identity }
  const draftVersion = useRef(0)
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId
  const updateDraft = (change: (value: string) => void) => (value: string) => { draftVersion.current += 1; change(value) }
  useEffect(() => {
    scope.current = createRequestScope(identity)
    if (previousConnection.current !== connectionIdentity) {
      setItems([]); setSelectedId(''); selectedRef.current = ''; setText(''); setTitle(''); setSummary(''); setTags(''); setSearch('')
    }
    previousConnection.current = connectionIdentity
    setResult(undefined); setError(''); setRunError(''); setBusy(false)
    draftVersion.current += 1
    return () => { if (identityRef.current === identity) scope.current.dispose() }
  }, [identity])
  useEffect(() => {
    if (!active || !bridge.templates) return
    const ticket = scope.current.begin()
    void bridge.templates('knowledge-search', { connectionId: connection.id, generation: connection.generation, query: search }, ticket.signal)
      .then(body => { if (scope.current.isCurrent(ticket)) setItems((body as { items?: KnowledgeItem[] }).items || []) })
      .catch(caught => { if (scope.current.isCurrent(ticket)) setError(caught instanceof Error ? caught.message : '读取经验失败。') })
      .finally(() => scope.current.finish(ticket))
    return () => { scope.current.cancel(ticket) }
  }, [active, bridge, connection.id, connection.generation, executionContextKey, search])
  const select = (id: string) => {
    const item = items.find(entry => entry.id === id)
    draftVersion.current += 1
    selectedRef.current = item?.id || ''
    setSelectedId(selectedRef.current); setText(item?.text || ''); setTitle(item?.title || ''); setSummary(item?.summary || '')
    setTags(item?.tags.join(', ') || ''); setResult(undefined); setError(''); setRunError('')
  }
  const save = async () => {
    if (!bridge.templates || busy) return
    const ticket = scope.current.begin()
    const version = draftVersion.current
    const draftId = selectedRef.current
    setBusy(true); setError('')
    try {
      const current = items.find(item => item.id === selectedId)
      const item = await bridge.templates('knowledge-publish', { connectionId: connection.id, generation: connection.generation,
        text, title, summary, tags: tags.split(',').map(tag => tag.trim()).filter(Boolean),
        ...(current ? { id: current.id, expectedVersion: current.version } : {}) }, ticket.signal) as KnowledgeItem
      if (scope.current.isCurrent(ticket)) {
        setItems(previous => [item, ...previous.filter(entry => entry.id !== item.id)])
        if (draftVersion.current === version && selectedRef.current === draftId) { selectedRef.current = item.id; setSelectedId(item.id) }
      }
    } catch (caught) { if (scope.current.isCurrent(ticket) && draftVersion.current === version && selectedRef.current === draftId) setError(caught instanceof Error ? caught.message : '保存失败。') }
    finally { if (scope.current.isCurrent(ticket)) setBusy(false); scope.current.finish(ticket) }
  }
  const archive = async (id: string) => {
    if (!bridge.templates || busy) return
    const ticket = scope.current.begin()
    const version = draftVersion.current
    const draftId = selectedRef.current
    setBusy(true); setError('')
    try {
      await bridge.templates('knowledge-archive', { connectionId: connection.id, generation: connection.generation, id }, ticket.signal)
      if (scope.current.isCurrent(ticket)) {
        setItems(previous => previous.filter(item => item.id !== id))
        if (selectedRef.current === id && draftVersion.current === version) {
          draftVersion.current += 1; selectedRef.current = ''; setSelectedId(''); setText(''); setTitle(''); setSummary(''); setTags(''); setResult(undefined)
        }
      }
    } catch (caught) { if (scope.current.isCurrent(ticket) && draftVersion.current === version && selectedRef.current === draftId) setError(caught instanceof Error ? caught.message : '归档失败。') }
    finally { if (scope.current.isCurrent(ticket)) setBusy(false); scope.current.finish(ticket) }
  }
  const tryRun = async () => {
    if (!text.trim() || !connection.live || busy) return
    const ticket = scope.current.begin()
    const version = draftVersion.current
    const draftId = selectedRef.current
    setBusy(true); setError(''); setRunError('')
    try {
      const output = await runText(text, ticket.signal)
      if (scope.current.isCurrent(ticket) && draftVersion.current === version && selectedRef.current === draftId) { setResult(output); setRunError('') }
    } catch (caught) {
      if (scope.current.isCurrent(ticket) && draftVersion.current === version && selectedRef.current === draftId) { setRunError(caught instanceof Error ? caught.message : '试运行失败。'); setResult(undefined) }
    }
    finally { if (scope.current.isCurrent(ticket)) setBusy(false); scope.current.finish(ticket) }
  }
  return { items, search, setSearch, selectedId, select, text, setText: updateDraft(setText), title, setTitle: updateDraft(setTitle), summary, setSummary: updateDraft(setSummary), tags, setTags: updateDraft(setTags),
    result, error, runError, busy, save, archive, tryRun, useForQuery: () => { useForQuery(text) } }
}

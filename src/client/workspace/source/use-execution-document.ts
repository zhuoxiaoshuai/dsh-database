import { useEffect, useRef, useState } from 'react'
import type { Connection, WorkspaceBridge } from '../../../shared/workbench.ts'
import { emptyExecutionDocument, type ExecutionDocument } from '../../../shared/execution-document.ts'
import type { WorkbenchEvent } from '../../../shared/execution.ts'
import { useExecutionItems } from '../../ai-query-bus.ts'
import { createRequestScope } from '../parts/request-scope.ts'

export function useExecutionDocument(bridge: WorkspaceBridge, connection: Connection, executionContext: Record<string, string> = {}, executionContextKey = '') {
  const [document, setDocument] = useState<ExecutionDocument>(() => emptyExecutionDocument(connection.dialect))
  const [text, setText] = useState('')
  const [reply, setReply] = useState<unknown>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const pending = useRef(0)
  const unsaved = useRef(false)
  const editVersion = useRef(0)
  const savedVersion = useRef(0)
  const connectionIdentity = `${connection.id}\0${connection.generation || ''}`
  const identity = `${connectionIdentity}\0${executionContextKey}`
  const previousConnection = useRef(connectionIdentity)
  const textRef = useRef(text)
  textRef.current = text
  const revisionRef = useRef<number>()
  const contextRef = useRef(executionContext)
  contextRef.current = executionContext
  const contextSaved = useRef(!executionContextKey)
  const identityRef = useRef(identity)
  const scope = useRef(createRequestScope(identity))
  if (identityRef.current !== identity) { scope.current.invalidate(identity); contextSaved.current = !executionContextKey }
  identityRef.current = identity
  const connectionRef = useRef(connection)
  connectionRef.current = connection
  const documentRef = useRef(document)
  documentRef.current = document

  const load = async () => {
    if (!bridge.executions || !connection.live) return
    const ticket = scope.current.begin()
    try {
      const response = await bridge.executions('execution-document-get', { id: connection.id, generation: connection.generation }, ticket.signal) as { document?: ExecutionDocument }
      if (!scope.current.isCurrent(ticket) || !response.document || response.document.sourceId !== connection.dialect) return
      if (pending.current || unsaved.current) return
      revisionRef.current = response.document.revision
      documentRef.current = response.document; setDocument(response.document); setText(response.document.text)
      if (executionContextKey && JSON.stringify(response.document.context) !== JSON.stringify(contextRef.current)) {
        const saved = await bridge.executions('execution-document-update', { id: connection.id, generation: connection.generation,
          text: response.document.text, context: contextRef.current, revision: response.document.revision }, ticket.signal) as { document?: ExecutionDocument }
        if (!scope.current.isCurrent(ticket) || !saved.document || pending.current || unsaved.current) return
        response.document = saved.document
        revisionRef.current = saved.document.revision
      }
      documentRef.current = response.document
      contextSaved.current = true
      setDocument(response.document)
      setText(response.document.text)
    } finally { scope.current.finish(ticket) }
  }
  useEffect(() => {
    scope.current = createRequestScope(identity)
    const connectionChanged = previousConnection.current !== connectionIdentity
    previousConnection.current = connectionIdentity
    const preserve = !connectionChanged && (unsaved.current || textRef.current !== '')
    queue.current = Promise.resolve(); pending.current = 0; contextSaved.current = !executionContextKey
    if (connectionChanged) revisionRef.current = undefined
    if (!preserve) { unsaved.current = false; editVersion.current = 0; savedVersion.current = 0 }
    const empty = connectionChanged ? emptyExecutionDocument(connection.dialect) : documentRef.current
    documentRef.current = empty; setDocument(empty); if (connectionChanged) setText('')
    setReply(undefined); setError(''); setBusy(false)
    const owner = identity
    if (preserve && executionContextKey) saveDraft(textRef.current, false)
    else void load().catch(caught => { if (identityRef.current === owner) { unsaved.current = true; setError(caught instanceof Error ? caught.message : 'AI Query 读取失败。') } })
    return () => { if (identityRef.current === identity) scope.current.dispose() }
  }, [identity])

  const saveDraft = (value: string, takeControl = true) => {
    const version = ++editVersion.current
    setText(value)
    unsaved.current = true
    documentRef.current = { ...documentRef.current, text: value, ...(takeControl ? { controller: 'user' as const, controllerReason: 'user-edit' } : {}), context: contextRef.current }
    setDocument(documentRef.current)
    setReply(undefined); setError('')
    pending.current += 1
    const current = identity
    const context = { ...contextRef.current }
    queue.current = queue.current.catch(() => {}).then(async () => {
      if (!bridge.executions || identityRef.current !== current) return
      const ticket = scope.current.begin()
      try {
        const fresh = await bridge.executions('execution-document-get', { id: connection.id, generation: connection.generation }, ticket.signal) as { document?: ExecutionDocument }
        if (!scope.current.isCurrent(ticket)) return
        if (revisionRef.current === undefined) revisionRef.current = fresh.document?.revision
        const response = await bridge.executions('execution-document-update', { id: connection.id, generation: connection.generation,
          text: value, ...(executionContextKey ? { context } : {}), revision: revisionRef.current }, ticket.signal) as { document?: ExecutionDocument }
        if (scope.current.isCurrent(ticket) && response.document?.text === value) {
          savedVersion.current = version
          revisionRef.current = response.document.revision
          contextSaved.current = true
          if (editVersion.current === version) {
            documentRef.current = response.document; setDocument(response.document); unsaved.current = false; setError('')
          }
        }
      } finally { scope.current.finish(ticket) }
    }).catch(async caught => { if (identityRef.current === current) {
      setError(caught instanceof Error ? caught.message : 'AI Query 保存失败。')
      const ticket = scope.current.begin()
      try {
        const fresh = await bridge.executions!('execution-document-get', { id: connection.id, generation: connection.generation }, ticket.signal) as { document?: ExecutionDocument }
        if (scope.current.isCurrent(ticket)) revisionRef.current = fresh.document?.revision
      } catch { /* Keep the failed draft and the visible original error. */ }
      finally { scope.current.finish(ticket) }
    } })
      .finally(() => { if (identityRef.current === current) pending.current = Math.max(0, pending.current - 1) })
  }
  const edit = (value: string) => saveDraft(value)
  const control = async (controller: 'ai' | 'user') => {
    const owner = identity
    const version = editVersion.current
    if (controller === 'user') {
      documentRef.current = { ...documentRef.current, controller: 'user', controllerReason: 'user-takeover' }
      setDocument(documentRef.current)
    }
    try {
      await queue.current
      if (!bridge.executions || identityRef.current !== owner) return
      if (controller === 'ai' && editVersion.current !== version) throw new Error('内容已变化，请重新交还 AI。')
      if (controller === 'ai' && (unsaved.current || savedVersion.current !== editVersion.current)) throw new Error('当前内容尚未保存，不能交还 AI。')
      if (controller === 'ai' && !contextSaved.current) throw new Error('当前执行目标尚未保存，不能交还 AI。')
      const ticket = scope.current.begin()
      try {
        const response = await bridge.executions('execution-document-control', { id: connection.id, generation: connection.generation, controller }, ticket.signal) as { document?: ExecutionDocument }
        if (response.document && scope.current.isCurrent(ticket) && editVersion.current === version && !unsaved.current) {
          revisionRef.current = response.document.revision; documentRef.current = response.document; setDocument(response.document)
        } else if (controller === 'ai' && scope.current.isCurrent(ticket) && editVersion.current !== version) {
          // The Host may have accepted return-to-AI after a newer local edit. Restore user control there.
          await queue.current
          if (scope.current.isCurrent(ticket)) await bridge.executions('execution-document-control',
            { id: connection.id, generation: connection.generation, controller: 'user', reason: 'user-edit' }, ticket.signal)
        }
      } finally { scope.current.finish(ticket) }
    } catch (caught) { if (identityRef.current === owner) setError(caught instanceof Error ? caught.message : 'AI Query 控制权变更失败。') }
  }
  const run = async () => {
    if (!bridge.executions || !connection.live || busy) return
    const owner = identity
    const version = editVersion.current
    const ticket = scope.current.begin()
    setBusy(true); setError('')
    try {
      await queue.current
      if (!scope.current.isCurrent(ticket)) return
      if (unsaved.current || savedVersion.current !== editVersion.current) throw new Error('当前内容尚未保存，不能执行。')
      if (!contextSaved.current) throw new Error('当前执行目标尚未保存，不能执行。')
      if (editVersion.current !== version) throw new Error('内容已变化，请重新执行。')
      const controlled = await bridge.executions('execution-document-control', { id: connection.id, generation: connection.generation, controller: 'user', reason: 'user-run' }, ticket.signal) as { document?: ExecutionDocument }
      if (!scope.current.isCurrent(ticket)) return
      if (editVersion.current !== version) throw new Error('内容已变化，请重新执行。')
      if (!controlled.document?.text.trim()) throw new Error('请先输入命令。')
      revisionRef.current = controlled.document.revision; documentRef.current = controlled.document; setDocument(controlled.document)
      const result = await bridge.executions('execution-document-run', { id: connection.id, generation: connection.generation, revision: controlled.document.revision }, ticket.signal)
      if (scope.current.isCurrent(ticket) && !unsaved.current && editVersion.current === version && documentRef.current.revision === controlled.document.revision) setReply(result)
    } catch (caught) { if (scope.current.isCurrent(ticket)) setError(caught instanceof Error ? caught.message : '执行失败。') }
    finally { if (scope.current.isCurrent(ticket) && identityRef.current === owner) setBusy(false); scope.current.finish(ticket) }
  }
  const applyEvent = (event: WorkbenchEvent) => {
    const current = connectionRef.current
    if (event.connectionId !== current.id || event.generation !== current.generation) return
    if (event.type === 'EXECUTION_DOCUMENT_CHANGED' && event.document?.sourceId === current.dialect && !pending.current && !unsaved.current
      && event.document.revision >= documentRef.current.revision) {
      if (executionContextKey && JSON.stringify(event.document.context) !== JSON.stringify(contextRef.current)) return
      revisionRef.current = event.document.revision
      documentRef.current = event.document; setDocument(event.document); setText(event.document.text)
    }
    if (event.type === 'EXECUTION_FINISHED' && event.sourceResult && contextSaved.current && !pending.current && !unsaved.current
      && event.queryRevision === documentRef.current.revision) setReply(event.sourceResult)
  }
  useExecutionItems(bridge, page => {
    for (const event of page.events || []) applyEvent(event)
  })
  return { document, text, reply, error, busy, load, edit, retrySave: () => saveDraft(textRef.current, false), takeOver: () => control('user'), returnToAi: () => control('ai'), run }
}

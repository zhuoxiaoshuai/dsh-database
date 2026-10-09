import { useEffect, useReducer, useRef } from 'react'
import type { Connection, WorkspaceBridge } from '../../../shared/workbench.ts'
import { emptyExecutionDocument, type ExecutionDocument } from '../../../shared/execution-document.ts'
import type { WorkbenchEvent } from '../../../shared/execution.ts'
import { matchesResultOwner, type ResultIdentity } from '../../../shared/query-sync.ts'
import { useExecutionItems } from '../../ai-query-bus.ts'
import { createRequestScope } from '../parts/request-scope.ts'

type State = {
  confirmed?: ExecutionDocument; draft: ExecutionDocument; version: number; acknowledged: number; pending: number
  save: { status: 'idle' | 'saving' | 'failed' | 'conflict'; error?: string }
  readError: string; operationError: string; busy: boolean; controlling?: 'ai' | 'user'
}
type Action =
  | { type: 'edit'; text: string; context: Record<string, string>; takeControl: boolean }
  | { type: 'snapshot'; document: ExecutionDocument; version?: number; acknowledged?: number; preserveDraft?: boolean }
  | { type: 'settled' | 'retry' | 'reconnect' }
  | { type: 'save-failed' | 'read-failed'; error: string }
  | { type: 'reset'; source: Connection['dialect'] }
  | { type: 'operation'; busy?: boolean; error?: string; controlling?: 'ai' | 'user' | null }
const initial = (source: Connection['dialect']): State => ({ draft: emptyExecutionDocument(source), version: 0,
  acknowledged: 0, pending: 0, save: { status: 'idle' }, readError: '', operationError: '', busy: false })
const dirty = (s: State) => s.version !== s.acknowledged
const blocked = (s: State) => s.save.status === 'failed' || s.save.status === 'conflict'
const sameContext = (a: Record<string, string>, b: Record<string, string>) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key])

/** Local edits and every remote document reply use this single acceptance boundary. */
function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'reset': return initial(a.source)
    case 'edit': return { ...s, version: s.version + 1, pending: s.pending + 1,
      draft: { ...s.draft, text: a.text, context: a.context, ...(a.takeControl ? { controller: 'user', controllerReason: 'user-edit' } : {}) },
      save: blocked(s) ? s.save : { status: 'saving' }, operationError: '' }
    case 'snapshot': {
      const remote = a.document
      if (remote.sourceId !== s.draft.sourceId || (s.confirmed && remote.revision < s.confirmed.revision)) return s
      if (a.version !== undefined && a.version !== s.version && a.acknowledged === undefined && (!a.preserveDraft || !dirty(s))) return s
      const acknowledged = a.acknowledged === undefined ? s.acknowledged : Math.max(s.acknowledged, a.acknowledged)
      const replace = s.version === acknowledged && (!a.preserveDraft || !dirty(s))
      return { ...s, confirmed: remote, acknowledged, readError: '', draft: replace ? remote : { ...s.draft, revision: remote.revision },
        save: a.acknowledged !== undefined && replace ? { status: s.pending > 1 ? 'saving' : 'idle' } : s.save }
    }
    case 'settled': {
      const pending = Math.max(0, s.pending - 1)
      return { ...s, pending, save: blocked(s) ? s.save : { status: pending ? 'saving' : 'idle' } }
    }
    case 'save-failed': return { ...s, save: { status: /修订|变化|冲突/.test(a.error) ? 'conflict' : 'failed', error: a.error } }
    case 'read-failed': return { ...s, readError: a.error }
    case 'retry': return { ...s, save: { status: 'idle' } }
    case 'reconnect': return { ...s, confirmed: undefined, pending: 0, busy: false, controlling: undefined, operationError: '',
      save: dirty(s) ? { status: 'failed', error: s.save.error || '连接已变化，本地草稿已保留，请重试保存。' } : { status: 'idle' } }
    case 'operation': return { ...s, ...(a.busy !== undefined ? { busy: a.busy } : {}),
      ...(a.error !== undefined ? { operationError: a.error } : {}), ...(a.controlling !== undefined ? { controlling: a.controlling ?? undefined } : {}) }
  }
}

export function useExecutionDocument(bridge: WorkspaceBridge, connection: Connection, executionContext: Record<string, string> = {}, executionContextKey = '') {
  const [state, dispatch] = useReducer(reducer, connection.dialect, initial)
  // Async work reads the current reducer state, not an independently mutable document.
  const current = useRef(state)
  const commit = (action: Action) => { current.current = reducer(current.current, action); dispatch(action) }
  const queue = useRef<Promise<void>>(Promise.resolve())
  const formatting = useRef<Promise<ExecutionDocument>>()
  const identity = `${connection.id}\0${connection.dialect}\0${connection.generation || ''}\0${executionContextKey}`
  const identityRef = useRef(identity)
  const scope = useRef(createRequestScope(identity))
  if (identityRef.current !== identity) scope.current.invalidate(identity)
  identityRef.current = identity
  const connectionRef = useRef(connection); connectionRef.current = connection
  const contextRef = useRef(executionContext); contextRef.current = executionContext
  const previous = useRef({ id: connection.id, source: connection.dialect, generation: connection.generation, context: executionContextKey })
  const resultOwner = () => {
    const binding = connectionRef.current, document = current.current.draft
    return { connectionId: binding.id, generation: binding.generation, sql: document.text, queryRevision: document.revision, controller: document.controller,
      ...(binding.dialect === 'mysql' || binding.dialect === 'oracle' ? { schema: document.context.schema || '' } : { context: document.context }) }
  }
  const load = async (preserveDraft = false) => {
    if (!bridge.executions || !connection.live) return
    const ticket = scope.current.begin(), version = current.current.version
    try {
      const response = await bridge.executions('execution-document-get', { id: connection.id, generation: connection.generation }, ticket.signal) as { document?: ExecutionDocument }
      if (!scope.current.isCurrent(ticket) || !response.document) return
      commit({ type: 'snapshot', document: response.document, version, preserveDraft })
      if (version === current.current.version && !dirty(current.current) && executionContextKey
        && !sameContext(current.current.draft.context, contextRef.current)) saveDraft(current.current.draft.text, false, contextRef.current)
    } catch (error) {
      if (scope.current.isCurrent(ticket)) throw error
    } finally { scope.current.finish(ticket) }
  }
  const saveDraft = (text: string, takeControl = true, target = current.current.draft.context, source = 'user') => {
    const context = { ...target }
    commit({ type: 'edit', text, context, takeControl })
    const version = current.current.version, owner = identity
    queue.current = queue.current.catch(() => {}).then(async () => {
      if (!bridge.executions || identityRef.current !== owner) return
      if (blocked(current.current)) throw new Error(current.current.save.error || '最后本地草稿已保留，请显式重试保存。')
      const ticket = scope.current.begin()
      try {
        if (!scope.current.isCurrent(ticket)) return
        if (!current.current.confirmed) {
          const fresh = await bridge.executions('execution-document-get', { id: connection.id, generation: connection.generation }, ticket.signal) as { document?: ExecutionDocument }
          if (!scope.current.isCurrent(ticket)) return
          if (fresh.document) commit({ type: 'snapshot', document: fresh.document, preserveDraft: true })
        }
        const revision = current.current.confirmed?.revision
        if (revision === undefined) throw new Error('尚未读取权威文档，请刷新后重试。')
        const response = await bridge.executions('execution-document-update', { id: connection.id, generation: connection.generation, text, context, revision, source }, ticket.signal) as { document?: ExecutionDocument }
        if (!scope.current.isCurrent(ticket)) return
        if (!response.document || response.document.text !== text || !sameContext(response.document.context, context)) throw new Error('保存回执与草稿不一致，请刷新后重试。')
        commit({ type: 'snapshot', document: response.document, acknowledged: version })
      } finally { scope.current.finish(ticket) }
    }).catch(async caught => {
      if (identityRef.current !== owner) return
      commit({ type: 'save-failed', error: caught instanceof Error ? caught.message : 'AI Query 保存失败。' })
      await load(true).catch(() => {})
    }).finally(() => { if (identityRef.current === owner) commit({ type: 'settled' }) })
  }
  useEffect(() => {
    scope.current = createRequestScope(identity)
    const old = previous.current
    previous.current = { id: connection.id, source: connection.dialect, generation: connection.generation, context: executionContextKey }
    queue.current = Promise.resolve()
    if (old.id !== connection.id || old.source !== connection.dialect) commit({ type: 'reset', source: connection.dialect })
    else if (old.generation !== connection.generation) commit({ type: 'reconnect' })
    else if (old.context !== executionContextKey) {
      commit({ type: 'reconnect' })
      if (!blocked(current.current)) saveDraft(current.current.draft.text, false, contextRef.current)
      else {
        commit({ type: 'edit', text: current.current.draft.text, context: { ...contextRef.current }, takeControl: false })
        commit({ type: 'settled' })
      }
    }
    const owner = identity
    void load(dirty(current.current)).catch(caught => {
      if (identityRef.current === owner) commit({ type: 'read-failed', error: caught instanceof Error ? caught.message : 'AI Query 读取失败。' })
    })
    return () => scope.current.dispose()
  }, [identity])
  const flush = async () => {
    await queue.current
    if (dirty(current.current) || current.current.pending || blocked(current.current)) throw new Error(current.current.save.error || '当前草稿尚未保存，请重试保存。')
    if (!current.current.confirmed) throw new Error('尚未读取权威文档，请刷新后重试。')
    return current.current.confirmed
  }
  const control = (controller: 'ai' | 'user'): Promise<void> => {
    const owner = identity, version = current.current.version
    if (current.current.controlling) return queue.current
    commit({ type: 'operation', controlling: controller, error: '' })
    const task = queue.current.catch(() => {}).then(async () => {
      if (!bridge.executions || identityRef.current !== owner) throw new Error('连接已变化，控制操作未完成。')
      if (controller === 'ai' && (version !== current.current.version || dirty(current.current) || blocked(current.current))) throw new Error('内容已变化或尚未保存，不能交还 AI。')
      const ticket = scope.current.begin()
      try {
        if (!current.current.confirmed) await load(true)
        if (!scope.current.isCurrent(ticket)) throw new Error('连接已变化，控制操作未完成。')
        const response = await bridge.executions('execution-document-control', { id: connection.id, generation: connection.generation, controller, revision: current.current.confirmed?.revision }, ticket.signal) as { document?: ExecutionDocument }
        if (!scope.current.isCurrent(ticket)) throw new Error('连接已变化，控制操作未完成。')
        if (!response.document || response.document.controller !== controller) throw new Error('控制回执缺失或不一致，请刷新后重试。')
        commit({ type: 'snapshot', document: response.document, acknowledged: current.current.acknowledged })
        if (controller === 'ai' && version !== current.current.version) {
          const restored = await bridge.executions('execution-document-control', { id: connection.id, generation: connection.generation, controller: 'user', reason: 'user-edit', revision: current.current.confirmed?.revision }, ticket.signal) as { document?: ExecutionDocument }
          if (scope.current.isCurrent(ticket) && restored.document) commit({ type: 'snapshot', document: restored.document, acknowledged: current.current.acknowledged })
          throw new Error('归还期间内容再次变化，已保留用户控制，请保存后重试。')
        }
      } finally { scope.current.finish(ticket) }
    }).catch(caught => {
      if (identityRef.current === owner) commit({ type: 'operation', error: caught instanceof Error ? caught.message : '控制权变更失败。' })
      throw caught
    }).finally(() => { if (identityRef.current === owner) commit({ type: 'operation', controlling: null }) })
    queue.current = task
    return task
  }
  const run = async (executionText?: string) => {
    if (!bridge.executions || !connection.live || current.current.busy || current.current.controlling) return
    const version = current.current.version, ticket = scope.current.begin()
    let executionIdentity: ResultIdentity | undefined
    commit({ type: 'operation', busy: true, error: '' })
    try {
      await flush()
      if (!scope.current.isCurrent(ticket)) return
      if (version !== current.current.version) throw new Error('内容已变化，请重新执行。')
      await control('user')
      if (!scope.current.isCurrent(ticket)) return
      if (version !== current.current.version || dirty(current.current)) throw new Error('内容已变化，请重新执行。')
      const controlled = current.current.confirmed!
      if (executionContextKey && !sameContext(controlled.context, contextRef.current)) throw new Error('当前执行目标尚未保存，不能执行。')
      if (!controlled.text.trim()) throw new Error('请先输入命令。')
      executionIdentity = { ...resultOwner(), documentText: controlled.text, executedSql: executionText ?? controlled.text, initiator: 'user' }
      const reply = await bridge.executions('execution-document-run', { id: connection.id, generation: connection.generation, revision: controlled.revision, ...(executionText !== undefined ? { text: executionText } : {}) }, ticket.signal)
      if (!reply || typeof reply !== 'object' || !('identity' in reply)) throw new Error('缺少有效执行身份，结果未接收。')
      if (scope.current.isCurrent(ticket) && !dirty(current.current) && version === current.current.version
        && matchesResultOwner((reply as {identity: ResultIdentity}).identity, { ...resultOwner(), context: controlled.context })) {
        return reply
      }
    } catch (caught) {
      if (scope.current.isCurrent(ticket) && version === current.current.version && (!executionIdentity || matchesResultOwner(executionIdentity, resultOwner()))) {
        commit({ type: 'operation', error: caught instanceof Error ? caught.message : '执行失败。' })
        const failure = caught as ResultIdentity & { executionId?: string; executionStatus?: string; steps?: unknown; batch?: unknown }
        if (failure.executionId && !dirty(current.current) && matchesResultOwner(failure, resultOwner())) {
          const reply = { ...failure, executionId: failure.executionId, status: failure.executionStatus, sql: failure.executedSql,
            result: { columns: [], rows: [], truncated: false, elapsedMs: 0, message: caught instanceof Error ? caught.message : '执行失败。', steps: failure.steps, batch: failure.batch } }
          return reply
        }
      }
    } finally { if (scope.current.isCurrent(ticket)) commit({ type: 'operation', busy: false }); scope.current.finish(ticket) }
  }
  const applyEvent = (event: WorkbenchEvent) => {
    const binding = connectionRef.current
    if (event.connectionId !== binding.id || event.generation !== binding.generation) return
    if (event.type === 'EXECUTION_DOCUMENT_CHANGED' && event.document && !current.current.pending && !dirty(current.current)) {
      if (executionContextKey && !sameContext(event.document.context, contextRef.current)) return
      commit({ type: 'snapshot', document: event.document, version: current.current.version })
    }

  }
  useExecutionItems(bridge, page => {
    if (page.gap) { void load().catch(caught => commit({ type: 'read-failed', error: caught instanceof Error ? caught.message : '文档恢复失败。' })); return }
    for (const event of page.events || []) applyEvent(event)
  }, () => { void load().catch(() => {}) })
  const formatText = (formatter: (text: string) => string): Promise<ExecutionDocument> => {
    if (formatting.current) return formatting.current
    const owner = identity, version = current.current.version
    const task = (async () => {
      const saved = await flush()
      if (identityRef.current !== owner || version !== current.current.version) throw new Error('内容已变化，请重新格式化；本地草稿已保留。')
      saveDraft(formatter(saved.text), false, saved.context, 'format')
      return flush()
    })()
    formatting.current = task
    void task.finally(() => { if (formatting.current === task) formatting.current = undefined }).catch(() => {})
    return task
  }
  return { document: state.draft, text: state.draft.text, error: state.operationError || state.save.error || state.readError,
    busy: state.busy || !!state.controlling, controlling: state.controlling, saveFailed: !!state.save.error, confirmedController: state.confirmed?.controller ?? 'ai', unsaved: dirty(state) || state.pending > 0, load, edit: (text: string, context?: Record<string, string>) => saveDraft(text, true, context),
    flush, formatText, retrySave: () => { commit({ type: 'retry' }); saveDraft(current.current.draft.text, false, current.current.draft.context) },
    takeOver: () => control('user'), returnToAi: () => control('ai'), run }
}
export type ExecutionDocumentController = ReturnType<typeof useExecutionDocument>

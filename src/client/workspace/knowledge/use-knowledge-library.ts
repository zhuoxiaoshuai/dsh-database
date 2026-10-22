import { createElement, Fragment, useEffect, useRef, useState } from 'react'
import type { Connection, WorkspaceBridge } from '../../../shared/workbench.ts'
import type { KnowledgeItem } from '../../../shared/knowledge.ts'
import { createRequestScope } from '../parts/request-scope.ts'
import { useKnowledgeTidy } from './use-knowledge-tidy.ts'
import { acceptDraft, DraftSessions, editDraft, newDraft, shouldRetainDraft, type DraftSession } from './draft-session.ts'
import { DraftRecovery } from './draft-recovery.tsx'
import { KnowledgeExecutionScope, knowledgeCommandReceipt, type KnowledgeCommandReceipt } from './execution-owner.ts'
import { KnowledgeExecutionSnapshotView } from './execution-snapshot.tsx'

type Session = DraftSession & { text: string; title: string; summary: string; tags: string; run?: KnowledgeCommandReceipt }
const empty = (): Session => ({ ...newDraft(), text: '', title: '', summary: '', tags: '' })
const loaded = (item: KnowledgeItem): Session => ({ ...empty(), text: item.text, title: item.title, summary: item.summary, tags: item.tags.join(', '),
  base: { id: item.id, version: item.version, archiveGuard: item.archiveGuard, snapshot: { text: item.text, title: item.title, summary: item.summary, tags: [...item.tags] } } })

export function useKnowledgeLibrary(bridge: WorkspaceBridge, connection: Connection, active: boolean,
  runText: (text: string, signal?: AbortSignal) => Promise<unknown>, useForQuery: (text: string) => void, executionContextKey = '') {
  const [items, setItems] = useState<KnowledgeItem[]>([])
  const [search, setSearch] = useState('')
  const searchRef = useRef(search); searchRef.current = search
  const listSequence = useRef(0), writeEpoch = useRef(0)
  const [draft, setDraft] = useState<Session>(empty)
  const current = useRef(draft); current.current = draft
  const sessions = useRef(new DraftSessions<Session>())
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [revision, setRevision] = useState(0)
  const mutation = useRef<object>()
  const identity = [connection.dialect, connection.id, connection.generation || ''].join('\0')
  const identityRef = useRef(identity), scope = useRef(createRequestScope(identity))
  if (identityRef.current !== identity) { scope.current.invalidate(identity); identityRef.current = identity }
  const runIdentity = identity + '\0' + executionContextKey
  const runs = useRef(new KnowledgeExecutionScope(runIdentity))
  runs.current.setIdentity(runIdentity)
  const tidy = useKnowledgeTidy(bridge, connection, active, 'knowledge', () => setRevision(value => value + 1))
  const show = (next: Session) => { sessions.current.update(next); current.current = next; setDraft(next); setError(next.saveError || '') }
  const update = (next: Session) => {
    sessions.current.update(next)
    if (current.current.token === next.token) { current.current = next; setDraft(next) }
  }
  useEffect(() => {
    const ownScope = createRequestScope(identity); scope.current = ownScope
    sessions.current.clear(); mutation.current = undefined
    const next = empty(); sessions.current.set('__draft__', next); show(next)
    setItems([]); setSearch(''); setSaving(false)
    return () => ownScope.dispose()
  }, [identity])
  useEffect(() => {
    runs.current.invalidate()
    for (const session of sessions.current.values()) sessions.current.update({ ...session, executionPending: undefined, executionSnapshot: undefined, run: undefined })
    update({ ...current.current, executionPending: undefined, executionSnapshot: undefined, run: undefined }); setExecuting(false)
    return () => runs.current.invalidate()
  }, [runIdentity])
  const loadList = async (committed = false) => {
    if (!bridge.templates) return
    const sequence = ++listSequence.current, epoch = writeEpoch.current
    const ticket = scope.current.latest('search')
    const ownsList = () => scope.current.isCurrent(ticket) && sequence === listSequence.current && epoch === writeEpoch.current
    try {
      const body = await bridge.templates('knowledge-search', { connectionId: connection.id, generation: connection.generation, query: searchRef.current }, ticket.signal)
      if (ownsList()) setItems((body as { items?: KnowledgeItem[] }).items || [])
    } catch (caught) {
      if (ownsList()) setError(`${committed ? '操作已完成；列表刷新失败：' : ''}${caught instanceof Error ? caught.message : '读取经验失败。'}`)
    } finally { scope.current.finish(ticket) }
  }
  useEffect(() => {
    if (!active) return
    void loadList()
    return () => { ++listSequence.current }
  }, [active, bridge, identity, revision, search])
  const select = (id: string) => {
    const key = id || '__draft__', cached = sessions.current.get(key)
    if (!id) {
      if (shouldRetainDraft(current.current) || !current.current.base && current.current.text.trim()) sessions.current.keep(current.current)
      const next = empty(); sessions.current.set(key, next); show(next); return
    }
    const item = items.find(entry => entry.id === id)
    const stale = cached && item && !!cached.base && item.version > cached.base.version
    const next = cached && (cached.loadState !== 'ready' || shouldRetainDraft(cached) || !item || !stale) ? cached : item ? loaded(item) : undefined
    if (next) {
      sessions.current.set(key, next); show(next)
      if (stale && shouldRetainDraft(cached)) setError(cached?.executionSnapshot
        ? '条目已有更新，当前草稿和执行结果已保留，可重新加载查看最新内容。'
        : '条目已有更新，当前未保存修改已保留。可重新加载后查看最新内容。')
    }
  }
  const restore = (token: symbol) => {
    const next = sessions.current.byToken(token)
    if (!next) return
    if (shouldRetainDraft(current.current)) sessions.current.keep(current.current)
    sessions.current.recovered(token); sessions.current.set(next.base?.id || '__draft__', next); show(next)
  }
  const reload = async () => {
    const sent = current.current
    if (!sent.base || mutation.current || runs.current.current || !bridge.templates) return
    if (shouldRetainDraft(sent)) sessions.current.keep(sent)
    const pending = { ...empty(), base: sent.base, loadState: 'loading' as const }
    sessions.current.set(sent.base.id, pending); show(pending)
    const ticket = scope.current.begin()
    try {
      const item = await bridge.templates('knowledge-get', { connectionId: connection.id, generation: connection.generation, id: sent.base.id }, ticket.signal) as KnowledgeItem
      if (scope.current.isCurrent(ticket) && sessions.current.get(sent.base.id)?.token === pending.token) {
        const next = loaded(item); sessions.current.set(item.id, next)
        if (current.current.token === pending.token) show(next)
      }
    } catch (caught) {
      if (scope.current.isCurrent(ticket) && sessions.current.get(sent.base.id)?.token === pending.token) {
        const next = { ...pending, loadState: 'error' as const, saveError: caught instanceof Error ? caught.message : '读取失败。' }
        update(next); if (current.current.token === pending.token) setError(next.saveError)
      }
    } finally { scope.current.finish(ticket) }
  }
  const change = (patch: Partial<Session>) => { if (current.current.loadState === 'ready') update(editDraft(current.current, patch)) }
  const save = async (copy = false) => {
    const sent = current.current
    if (!bridge.templates || mutation.current || runs.current.current || executing || sent.loadState !== 'ready') return
    if (sent.archived && !copy) { setError('条目已归档，请另存为新模板。'); return }
    const request = {}; mutation.current = request
    const ticket = scope.current.begin()
    update({ ...sent, pending: request, saveError: '' }); setSaving(true); setError('')
    try {
      const base = copy ? undefined : sent.base
      const item = await bridge.templates('knowledge-publish', { connectionId: connection.id, generation: connection.generation,
        text: sent.text, title: sent.title, summary: sent.summary, tags: sent.tags.split(',').map(tag => tag.trim()).filter(Boolean),
        ...(base ? { id: base.id, expectedVersion: base.version } : {}) }, ticket.signal) as KnowledgeItem
      if (!scope.current.isCurrent(ticket)) return
      const owner = sessions.current.byToken(sent.token)
      if (owner?.pending === request) {
        const receipt = loaded(item), next = acceptDraft(owner, sent, receipt, receipt.base!)
        sessions.current.bindReceipt(item.id, next); update(next)
        if (current.current.token === sent.token) { sessions.current.set(item.id, next); setError('') }
      }
      setItems(previous => [item, ...previous.filter(entry => entry.id !== item.id)])
      ++writeEpoch.current
      await loadList(true)
    } catch (caught) {
      if (scope.current.isCurrent(ticket)) {
        const owner = sessions.current.byToken(sent.token)
        if (owner) { const message = caught instanceof Error ? caught.message : '保存失败。'; update({ ...owner, saveError: message }); if (current.current.token === owner.token) setError(message) }
      }
    } finally {
      if (scope.current.isCurrent(ticket) && mutation.current === request) {
        const owner = sessions.current.byToken(sent.token); if (owner) update({ ...owner, pending: undefined })
        mutation.current = undefined; setSaving(false)
      }
      scope.current.finish(ticket)
    }
  }
  const archive = async (id: string) => {
    if (!bridge.templates || mutation.current || runs.current.current || executing) return
    const request = {}; mutation.current = request
    const ticket = scope.current.begin(); setSaving(true); setError('')
    try {
      const guard = current.current.base?.id === id ? current.current.base.archiveGuard : items.find(item => item.id === id)?.archiveGuard
      await bridge.templates('knowledge-archive', { connectionId: connection.id, generation: connection.generation, id, archiveGuard: guard }, ticket.signal)
      if (scope.current.isCurrent(ticket)) {
        setItems(previous => previous.filter(item => item.id !== id))
        for (const session of sessions.current.values()) if (session.base?.id === id) update({ ...session, archived: true })
        ++writeEpoch.current
        await loadList(true)
      }
    } catch (caught) { if (scope.current.isCurrent(ticket)) setError(caught instanceof Error ? caught.message : '归档失败。') }
    finally { if (scope.current.isCurrent(ticket) && mutation.current === request) { mutation.current = undefined; setSaving(false) }; scope.current.finish(ticket) }
  }
  const tryRun = async () => {
    const sent = current.current
    if (!sent.text.trim() || !connection.live || mutation.current || executing || sent.loadState !== 'ready') return
    const ticket = runs.current.begin(sent.token, sent.text, sent.text, executionContextKey || connection.name || connection.dialect)
    if (!ticket) return
    update({ ...sent, executionPending: ticket, executionSnapshot: ticket.snapshot, run: { status: 'running', error: '' } }); setExecuting(true)
    const accept = (receipt: KnowledgeCommandReceipt) => {
      if (!runs.current.owns(ticket)) return
      const owner = sessions.current.byToken(ticket.owner)
      if (owner?.executionPending !== ticket) return
      update({ ...owner, executionSnapshot: { ...ticket.snapshot, status: receipt.status }, run: receipt })
    }
    try { accept(knowledgeCommandReceipt(await runText(sent.text, ticket.controller.signal))) }
    catch (caught) { accept(knowledgeCommandReceipt(caught, true)) }
    finally {
      if (runs.current.finish(ticket)) {
        const owner = sessions.current.byToken(ticket.owner)
        if (owner?.executionPending === ticket) update({ ...owner, executionPending: undefined })
        setExecuting(false)
      }
    }
  }
  const mutationBusy = saving || executing
  const busy = mutationBusy || draft.loadState !== 'ready'
  const analysis = createElement(Fragment, null,
    draft.base && createElement('button', { type: 'button', disabled: mutationBusy || draft.loadState === 'loading', onClick: () => void reload() }, draft.loadState === 'error' ? '重新读取' : draft.dirty ? '重新加载（保留草稿）' : '重新加载'),
    draft.archived && createElement('button', { type: 'button', disabled: busy, onClick: () => void save(true) }, '另存为新模板'),
    createElement(DraftRecovery, { drafts: sessions.current.recoverable(draft.token), disabled: mutationBusy, onRestore: restore }))
  return { items, search, setSearch, selectedId: draft.base?.id || '', select, text: draft.text, setText: (text: string) => change({ text }),
    title: draft.title, setTitle: (title: string) => change({ title }), summary: draft.summary, setSummary: (summary: string) => change({ summary }),
    tags: draft.tags, setTags: (tags: string) => change({ tags }), analysis, editorDisabled: draft.loadState !== 'ready',
    result: draft.run?.result, error, runError: draft.run?.error || '', busy,
    executionInfo: createElement(Fragment, null,
      executing && runs.current.current?.owner !== draft.token && createElement('p', { role: 'status' }, '其他草稿正在执行…'),
      createElement(KnowledgeExecutionSnapshotView, { snapshot: draft.executionSnapshot, text: draft.text })),
    save: () => save(), archive, tryRun, useForQuery: () => { if (current.current.loadState === 'ready') useForQuery(current.current.text) }, tidy }
}

import type { KnowledgeArchiveGuard } from '../../shared/knowledge.ts'
import type { KnowledgeLibraryProps } from '../workspace/knowledge/knowledge-library.tsx'
import { useKnowledgeTidy } from '../workspace/knowledge/use-knowledge-tidy.ts'
import { acceptDraft, DraftSessions, editDraft, newDraft, shouldRetainDraft, type DraftSession } from '../workspace/knowledge/draft-session.ts'
import { DraftRecovery } from '../workspace/knowledge/draft-recovery.tsx'
import { KnowledgeExecutionScope } from '../workspace/knowledge/execution-owner.ts'
import { KnowledgeExecutionSnapshotView } from '../workspace/knowledge/execution-snapshot.tsx'
import React, { useEffect, useRef, useState } from 'react'
import { ReadonlyResultGrid, ResultExportButtons } from '../results.tsx'
import { SqlRunWorkspace } from '../sql-run-workspace.tsx'
import { QueryResultFrame } from '../workspace/parts/layout/query-result-frame.tsx'
import { SqlReceipts } from './sql-receipts.tsx'
import { TableStructurePane } from '../table-structure-pane.tsx'
import { SqlToolbarSchemaTable } from '../sql-toolbar-schema-table.tsx'
import type { SchemaCache } from '../schema/schema-cache.ts'
import type { Connection, Result, WorkspaceBridge } from '../../shared/workbench.ts'
import { stripLeadingComments, UNPARSED_TEMPLATE_SUMMARY, unwrapExplainSql, wrapExplainSql } from '../../shared/sql-text.ts'
import { createSqlBatch, formatSqlBatchStatus, resultTabLabel, resolveRunStatements, runSqlBatch, statementKindLabel, stepStatusLabel, type SqlStep } from '../../shared/sql-batch.ts'
import { SQL_SPLIT_RATIO_DEFAULT } from '../sql-pane-layout.ts'

type TemplateSummary = {
  archiveGuard?: KnowledgeArchiveGuard
  id: string
  familyId: string
  version: number
  title: string
  summary: string
  tags: string[]
  dialect: string
  originalSql?: string
  lineageAmbiguous?: boolean
  features?: { operation?: string; tables?: string[]; risk?: string; parseOk?: boolean }
}

type SimilarHit = { id: string; title: string; score: number; reasons: string[]; version: number; expectedSnapshot?: { text: string; title: string; summary: string; tags: string[] } }

type Session = DraftSession & {
  lineageAmbiguous?: boolean
  base?: { id: string; version: number; archiveGuard?: KnowledgeArchiveGuard; snapshot: { text: string; title: string; summary: string; tags: string[] } }
  sql: string
  title: string
  summary: string
  tags: string
  similar: SimilarHit[]
  parseNote: string
  message: string
  steps: SqlStep[]
  activeStep: number
  pane: 'result' | 'message'
  ratio: number
  resultOpen: boolean
}

const emptySession = (): Session => ({
  ...newDraft(),
  sql: '',
  title: '',
  summary: '',
  tags: '',
  similar: [],
  parseNote: '',
  message: '',
  steps: [],
  activeStep: 0,
  pane: 'message',
  ratio: SQL_SPLIT_RATIO_DEFAULT,
  resultOpen: true,
})

function gridResult(step?: SqlStep): Result | undefined {
  const result = step?.result
  return result && result.columns.length > 0 && Array.isArray(result.rows) ? result : undefined
}

function sessionKey(id?: string): string {
  return id || '__draft__'
}

function registerSqlDraft(sessions: DraftSessions<Session>, draft = emptySession()): Session {
  sessions.set('__draft__', draft)
  return draft
}

export type SqlKnowledgeProps = {

  bridge: WorkspaceBridge
  connection?: Connection
  schema?: string
  schemas?: string[]
  cache?: SchemaCache
  initialSql?: string
  focusTemplateId?: string
  onClose(): void
  onApply?(sql: string): void
  onSaved?(templateId: string): void
  onSchemaChange?(schema: string): void
  embedded?: boolean
  reloadKey?: number
  active?: boolean
}

export function useSqlKnowledge({
  bridge, connection, schema, schemas, cache, initialSql, focusTemplateId, onClose, onApply, onSaved, onSchemaChange, embedded, reloadKey, active: tabActive = true,
}: SqlKnowledgeProps): KnowledgeLibraryProps {
  const [query, setQuery] = useState('')
  const queryRef = useRef(query); queryRef.current = query
  const [items, setItems] = useState<TemplateSummary[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [selectionEpoch, setSelectionEpoch] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [selection, setSelection] = useState('')
  const cursorRef = useRef(0)
  const [picked, setPicked] = useState('')
  const [showStructure, setShowStructure] = useState(false)
  const sessions = useRef(new DraftSessions<Session>())
  const saveInFlight = useRef<object>()
  const loadSeq = useRef(0)
  const [active, setActive] = useState<Session>(() => ({ ...emptySession(), sql: initialSql || '' }))
  const searchSeq = useRef(0)
  const previewSeq = useRef(0)
  const runs = useRef(new KnowledgeExecutionScope(''))
  const dialect = connection?.dialect || 'mysql'
  const connectionId = connection?.id || ''
  const refreshList = useRef<() => void>(() => {})
  const tidy = useKnowledgeTidy(bridge, connection, tabActive, 'template', () => refreshList.current())
  const schemaList = schemas || []
  const identity = `${dialect}\0${connectionId}\0${connection?.generation || ''}`
  const identityRef = useRef(identity)
  identityRef.current = identity
  const identityStamp = useRef({ identity })
  if (identityStamp.current.identity !== identity) identityStamp.current = { identity }
  const stamp = identityStamp.current
  const ownsIdentity = () => identityRef.current === identity && identityStamp.current === stamp
  runs.current.setIdentity(`${identity}\0${schema || ''}`)
  const selectedKey = useRef(sessionKey(selectedId))
  selectedKey.current = sessionKey(selectedId)
  const activeRef = useRef(active)
  activeRef.current = active
  const editVersions = useRef(new Map<string, number>())
  const versionFor = (key: string) => editVersions.current.get(key) || 0
  const currentDraft = (key: string, version: number) => ownsIdentity() && selectedKey.current === key && versionFor(key) === version

  const persistSession = (key: string, patch: Partial<Session>) => {
    const prev = selectedKey.current === key ? activeRef.current : sessions.current.get(key) || emptySession()
    const next = { ...prev, ...patch }
    sessions.current.update(next)
    if (selectedKey.current === key) { activeRef.current = next; setActive(next) }
  }
  const editSession = (key: string, patch: Partial<Session>) => {
    if (!ownsIdentity() || selectedKey.current !== key || activeRef.current.loadState !== 'ready') return
    editVersions.current.set(key, versionFor(key) + 1)
    persistSession(key, editDraft(activeRef.current, patch))
  }

  const loadList = async (text = queryRef.current, committed = false) => {
    const seq = ++searchSeq.current
    try {
      if (!connectionId) { setItems([]); return }
      const result = await bridge.templates!('template-search', { query: text, dialect, connectionId }) as { items?: TemplateSummary[] }
      if (seq !== searchSeq.current || !ownsIdentity()) return
      setItems(result.items || [])
    } catch (e) {
      if (seq !== searchSeq.current || !ownsIdentity()) return
      setError(`${committed ? '操作已完成；列表刷新失败：' : ''}${e instanceof Error ? e.message : '无法检索模板'}`)
    }
  }
  refreshList.current = () => { void loadList(query) }

  useEffect(() => {
    void loadList('')
  }, [bridge, connectionId, connection?.generation, dialect, reloadKey])

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadList(query) }, 300)
    return () => window.clearTimeout(timer)
  }, [query, bridge, connectionId, dialect])

  useEffect(() => {
    if (!focusTemplateId) return
    selectSession(focusTemplateId)
  }, [focusTemplateId])

  useEffect(() => {
    if (!selectedId) return
    const key = sessionKey(selectedId)
    const cached = sessions.current.get(key)
    if (cached?.loadState === 'ready') { activeRef.current = cached; setActive(cached); return }
    const pending = cached || { ...emptySession(), loadState: 'loading' as const }
    sessions.current.set(key, pending)
    activeRef.current = pending; setActive(pending)
    const seq = ++loadSeq.current
    let alive = true
    void bridge.templates!('template-get', { id: selectedId, connectionId }).then(raw => {
      if (!alive || !ownsIdentity() || seq !== loadSeq.current || selectedKey.current !== key || sessions.current.get(key)?.token !== pending.token) return
      const item = raw as TemplateSummary & { originalSql?: string }
      const loaded: Session = {
        ...emptySession(),
        lineageAmbiguous: item.lineageAmbiguous,
        base: { id: item.id, version: item.version, archiveGuard: item.archiveGuard, snapshot: { text: item.originalSql || '', title: item.title || '', summary: item.summary || '', tags: [...(item.tags || [])] } },
        sql: item.originalSql || '',
        title: item.title || '',
        summary: item.summary || '',
        tags: (item.tags || []).join(', '),
        similar: [],
        parseNote: '',
        message: '',
        steps: [],
        activeStep: 0,
        pane: 'message',
        ratio: SQL_SPLIT_RATIO_DEFAULT,
        resultOpen: true,
      }
      sessions.current.set(key, loaded)
      activeRef.current = loaded; setActive(loaded)
      void refreshPreview(loaded.sql, key)
    }).catch(e => {
      if (alive && ownsIdentity() && seq === loadSeq.current && selectedKey.current === key && sessions.current.get(key)?.token === pending.token) {
        persistSession(key, { loadState: 'error' })
        setError(e instanceof Error ? e.message : '无法读取模板')
      }
    })
    return () => { alive = false }
  }, [selectedId, bridge, identity, selectionEpoch])

  const refreshPreview = async (sql: string, key: string) => {
    if (!sql.trim()) return
    const seq = ++previewSeq.current
    const version = versionFor(key)
    const token = (sessions.current.get(key) || activeRef.current).token
    const ownsPreview = () => currentDraft(key, version) && activeRef.current.token === token && activeRef.current.loadState === 'ready'
    try {
      if (!connectionId) return
      const result = await bridge.templates!('template-preview', { sql, dialect, connectionId }) as {
        draft?: { suggestedTitle?: string; suggestedSummary?: string; suggestedTags?: string[]; features?: { parseOk?: boolean } }
        similar?: SimilarHit[]
      }
      if (seq !== previewSeq.current || !ownsPreview()) return
      const prev = sessions.current.get(key) || active
      const summary = prev.summary === UNPARSED_TEMPLATE_SUMMARY ? '' : prev.summary
      persistSession(key, {
        title: prev.title || result.draft?.suggestedTitle || '',
        summary: summary || result.draft?.suggestedSummary || '',
        tags: prev.tags || (result.draft?.suggestedTags || []).join(', '),
        similar: result.similar || [],
        parseNote: result.draft?.features?.parseOk === false ? '未能完整解析，相似合并需人工确认。' : '',
      })
    } catch (e) {
      if (seq !== previewSeq.current || !ownsPreview()) return
      setError(e instanceof Error ? e.message : '无法分析 SQL')
    }
  }

  useEffect(() => {
    const key = sessionKey(selectedId)
    const timer = window.setTimeout(() => { void refreshPreview(active.sql, key) }, 400)
    return () => window.clearTimeout(timer)
  }, [active.sql, connectionId, dialect, bridge, selectedId])

  useEffect(() => {
    identityRef.current = identity
    return () => {
      identityRef.current = ''
      runs.current.invalidate()
      ++searchSeq.current; ++previewSeq.current
    }
  }, [identity])
  useEffect(() => { setSelection(''); cursorRef.current = 0 }, [selectedId])
  const priorIdentity = useRef(identity)
  useEffect(() => {
    if (priorIdentity.current !== identity) {
      sessions.current.clear(); editVersions.current.clear()
      ++loadSeq.current; saveInFlight.current = undefined
      const next = registerSqlDraft(sessions.current); activeRef.current = next; setActive(next); setSelectedId(undefined); selectedKey.current = '__draft__'
      setItems([]); setError(''); priorIdentity.current = identity
    } else if (selectedKey.current === '__draft__') registerSqlDraft(sessions.current, activeRef.current)
    setBusy(false); setExecuting(false)
  }, [identity])
  useEffect(() => {
    runs.current.invalidate()
    for (const value of sessions.current.values()) sessions.current.update({ ...value, steps: [], activeStep: 0, message: '', executionPending: undefined, executionSnapshot: undefined })
    const next = { ...activeRef.current, steps: [], activeStep: 0, message: '', executionPending: undefined, executionSnapshot: undefined }
    sessions.current.update(next); activeRef.current = next; setActive(next)
    setBusy(!!saveInFlight.current); setExecuting(false)
  }, [schema])

  const runBatch = async (nextSteps: SqlStep[], opts?: { from?: number; only?: number }) => {
    if (!connection?.live || !schema || !nextSteps.length) return
    const sent = activeRef.current
    const ticket = runs.current.begin(sent.token, sent.sql, nextSteps.map(step => step.sql).join(';\n'), schema)
    if (!ticket) return
    const controller = ticket.controller
    const ownsRun = () => ownsIdentity() && runs.current.owns(ticket) && sessions.current.byToken(ticket.owner)?.executionPending === ticket
    const updateRun = (patch: Partial<Session>) => {
      if (!ownsRun()) return
      const owner = sessions.current.byToken(ticket.owner)!
      const next = { ...owner, ...patch }
      sessions.current.update(next)
      if (activeRef.current.token === ticket.owner) { activeRef.current = next; setActive(next) }
    }
    sessions.current.update({ ...sent, executionPending: ticket })
    setBusy(true)
    setExecuting(true)
    updateRun({ executionSnapshot: ticket.snapshot, steps: nextSteps, activeStep: opts?.only ?? opts?.from ?? 0, pane: 'result', message: '', resultOpen: true })
    let terminalStatus: string | undefined
    try {
      const finished = await runSqlBatch({
        steps: nextSteps,
        from: opts?.from,
        only: opts?.only,
        signal: controller.signal,
        execute: async (text, signal) => {
          try {
            const result = bridge.executeKnowledge
              ? await bridge.executeKnowledge({ ...connection, database: schema }, text, { signal: ticket.receiptController.signal, stopSignal: signal })
              : await (bridge.executeManual || bridge.execute)({ ...connection, database: schema }, text, signal)
            terminalStatus = (result as { executionStatus?: string }).executionStatus
            if (!bridge.executeKnowledge && signal.aborted) throw Object.assign(new Error('执行已停止，迟到结果不作为成功确认。'), { effect: 'unknown', executionStatus: 'unknown' })
            return result
          } catch (caught) {
            terminalStatus = (caught as { executionStatus?: string; effect?: string }).executionStatus || ((caught as { effect?: string }).effect === 'unknown' ? 'unknown' : undefined)
            throw caught
          }
        },
        onChange: live => {
          if (!ownsRun() || controller.signal.aborted) return
          const current = live.findIndex(step => step.status === 'running')
          const fallback = live.findLastIndex(step => step.status === 'ok' || step.status === 'failed' || step.status === 'cancelled' || step.status === 'unknown')
          updateRun({ steps: live, activeStep: current >= 0 ? current : Math.max(0, fallback) })
        },
      })
      if (!ownsRun()) return
      const failedIndex = finished.findIndex(step => step.status === 'failed' || step.status === 'cancelled' || step.status === 'unknown')
      const firstGrid = finished.findIndex(step => step.status === 'ok' && gridResult(step))
      const focus = opts?.only ?? (failedIndex >= 0 ? failedIndex : firstGrid >= 0 ? firstGrid : Math.max(0, finished.length - 1))
      updateRun({
        executionSnapshot: { ...ticket.snapshot, status: terminalStatus === 'unknown' || finished.some(step => step.status === 'unknown') ? 'unknown' : terminalStatus === 'failed' || finished.some(step => step.status === 'failed') ? 'failed' : terminalStatus === 'cancelled' || finished.some(step => step.status === 'cancelled') ? 'cancelled' : 'succeeded' },
        steps: finished,
        activeStep: focus,
        pane: finished.some(step => step.status === 'failed' || step.status === 'unknown') ? 'message' : 'result',
        resultOpen: true,
        message: finished.map((step, index) => {
          const head = `${index + 1} · ${statementKindLabel(step.kind)} · ${stepStatusLabel(step.status)}`
          const body = step.error || step.result?.message || ''
          return `${head}${body ? `\n${body}` : ''}`
        }).join('\n\n'),
      })
    } finally {
      if (runs.current.finish(ticket) && ownsIdentity()) {
        const owner = sessions.current.byToken(ticket.owner)
        if (owner?.executionPending === ticket) {
          const next = { ...owner, executionPending: undefined }
          sessions.current.update(next)
          if (activeRef.current.token === ticket.owner) { activeRef.current = next; setActive(next) }
        }
        setBusy(false); setExecuting(false)
      }
    }
  }
  const execute = async (runSelection?: string, mode: 'current' | 'all' = 'all') => {
    if (busy || runs.current.current || saveInFlight.current || !connection || activeRef.current.loadState !== 'ready') return
    const ranges = resolveRunStatements({
      sql: active.sql,
      dialect: connection.dialect,
      selection: runSelection ?? selection,
      cursor: cursorRef.current,
      mode: mode === 'all' ? 'all' : 'selection-or-current',
    })
    if (!ranges.length) return
    await runBatch(createSqlBatch(ranges.map(item => item.sql)))
  }
  const explain = async (runSelection?: string) => {
    if (!connection || busy || runs.current.current || saveInFlight.current || activeRef.current.loadState !== 'ready') return
    const ranges = resolveRunStatements({
      sql: active.sql,
      dialect: connection.dialect,
      selection: runSelection ?? selection,
      cursor: cursorRef.current,
      mode: 'selection-or-current',
    })
    const text = ranges[0]?.sql || ''
    if (!text.trim()) return
    const inner = stripLeadingComments(unwrapExplainSql(text))
    if (!/^(with\b[\s\S]*\bselect\b|select\b)/i.test(inner)) {
      persistSession(sessionKey(selectedId), { steps: [], activeStep: 0, pane: 'message', message: '解释仅支持 SELECT 查询。', resultOpen: true })
      return
    }
    await runBatch(createSqlBatch([wrapExplainSql(connection.dialect, text)]))
  }

  const publishDraft = async (target?: { publishAction: string; targetId?: string; expectedVersion?: number; expectedSnapshot?: SimilarHit['expectedSnapshot'] }) => {
    const sent = activeRef.current
    if (busy || runs.current.current || saveInFlight.current || sent.loadState !== 'ready' || !sent.sql.trim()) return
    if (sent.archived && target?.publishAction !== 'create') { setError('条目已归档，请另存为新模板。'); return }
    const request = {}; saveInFlight.current = request
    const origin = selectedKey.current
    // Persist the unsaved session as well: a selection change must not lose its receipt owner.
    sessions.current.set(origin, { ...sent, pending: request })
    const ownedSession = () => sessions.current.byToken(sent.token)
    const ownsSession = () => ownsIdentity() && !!ownedSession()
    const updateOwner = (next: Session) => {
      sessions.current.update(next)
      if (activeRef.current.token === sent.token) { activeRef.current = next; setActive(next) }
    }
    updateOwner({ ...sent, pending: request })
    setBusy(true); setError('')
    const base = sent.base
    try {
      if (!connectionId) throw new Error('请先选择连接。')
      const saved = await bridge.templates!('template-publish', {
        sql: sent.sql, dialect, connectionId,
        title: sent.title.trim() || '未命名', summary: sent.summary.trim(), tags: sent.tags.split(/[,，\s]+/).filter(Boolean),
        publishAction: base ? 'newVersion' : 'create',
        targetId: base?.id,
        expectedVersion: base?.version,
        expectedSnapshot: base?.snapshot,
        ...target,
        ...(target ? { expectedSnapshot: target.expectedSnapshot } : {}),
        ...(target?.publishAction === 'create' ? { targetId: undefined, expectedVersion: undefined, expectedSnapshot: undefined } : {}),
      }) as TemplateSummary
      if (!ownsIdentity()) return
      if (ownsSession()) {
        const current = ownedSession()!
        const accepted = { sql: saved.originalSql ?? sent.sql, title: saved.title, summary: saved.summary, tags: saved.tags.join(', ') }
        const next = { ...acceptDraft(current, sent, accepted, { id: saved.id, version: saved.version, archiveGuard: saved.archiveGuard,
          snapshot: { text: accepted.sql, title: saved.title, summary: saved.summary, tags: [...saved.tags] } }), lineageAmbiguous: saved.lineageAmbiguous }
        const key = sessionKey(saved.id)
        const isActive = activeRef.current.token === sent.token
        updateOwner(next)
        sessions.current.bindReceipt(key, next)
        if (origin === '__draft__' && sessions.current.get(origin)?.token === sent.token) sessions.current.delete(origin)
        if (isActive) {
          sessions.current.set(key, next)
          selectedKey.current = key; setSelectedId(saved.id)
          activeRef.current = next; setActive(next); setError('')
          onSaved?.(saved.id)
        }
      }
      await loadList(queryRef.current, true)
    } catch (e) {
      if (ownsSession()) {
        const message = e instanceof Error ? e.message : '保存失败'
        updateOwner({ ...ownedSession()!, saveError: message })
        if (activeRef.current.token === sent.token) setError(message)
      }
    } finally {
      if (ownsIdentity() && saveInFlight.current === request) {
        const owner = ownedSession(); if (owner) updateOwner({ ...owner, pending: undefined })
        saveInFlight.current = undefined; setBusy(false)
      }
    }
  }
  const publishSimilar = (publishAction: string, hit: SimilarHit) => publishDraft({ publishAction, targetId: hit.id, expectedVersion: hit.version, expectedSnapshot: hit.expectedSnapshot })
  const saveToDisk = () => publishDraft()

  const archiveItem = async (id: string, event: React.MouseEvent) => {
    event.stopPropagation()
    if (busy || runs.current.current || saveInFlight.current || activeRef.current.loadState !== 'ready') return
    const request = {}; saveInFlight.current = request
    const listed = items.find(item => item.id === id)
    setBusy(true)
    setError('')
    try {
      const guard = activeRef.current.base?.id === id ? activeRef.current.base.archiveGuard : listed?.archiveGuard
      const receipt = await bridge.templates!('template-archive', { id, connectionId, archiveGuard: guard }) as { archived?: string[] }
      if (!ownsIdentity()) return
      const archived = new Set(receipt.archived || [id])
      for (const session of sessions.current.values()) if (session.base && archived.has(session.base.id)) {
        const next = { ...session, archived: true }
        sessions.current.update(next)
        if (activeRef.current.token === next.token) { activeRef.current = next; setActive(next) }
      }
      await loadList(queryRef.current, true)
    } catch (e) {
      if (ownsIdentity()) setError(e instanceof Error ? e.message : '无法删除')
    } finally {
      if (ownsIdentity() && saveInFlight.current === request) { saveInFlight.current = undefined; setBusy(false) }
    }
  }


  const pickTable = (name: string) => {
    setPicked(name)
    setShowStructure(!!name)
  }
  const step = active.steps[active.activeStep]
  const shown = gridResult(step)
  const editorDisabled = active.loadState !== 'ready'
  const selectSession = (id: string, reload = false) => {
    if (reload && (runs.current.current || saveInFlight.current)) return
    const key = sessionKey(id)
    const previous = activeRef.current
    if (previous.loadState === 'ready') sessions.current.set(selectedKey.current, previous)
    const listed = items.find(item => item.id === id)
    let cached = sessions.current.get(key)
    if (!id) {
      if (cached && (shouldRetainDraft(cached) || cached.sql.trim())) sessions.current.keep(cached)
      sessions.current.delete(key); cached = registerSqlDraft(sessions.current)
    }
    const base = cached?.base
    const stale = listed && base && listed.version >= base.version && (listed.version !== base.version || listed.title !== base.snapshot.title
      || listed.summary !== base.snapshot.summary || JSON.stringify(listed.tags) !== JSON.stringify(base.snapshot.tags))
    setError(cached?.saveError || '')
    if (reload || stale && !shouldRetainDraft(cached) || cached?.loadState === 'error') {
      if (cached && shouldRetainDraft(cached)) sessions.current.keep(cached)
      sessions.current.delete(key); cached = undefined
      setError('')
      ++loadSeq.current; setSelectionEpoch(value => value + 1)
    } else if (stale && shouldRetainDraft(cached)) setError(cached?.executionSnapshot
      ? '条目已有更新，当前草稿和执行结果已保留，可重新加载查看最新内容。'
      : '条目已有更新，当前未保存修改已保留。可重新加载后查看最新内容。')
    const next = cached || { ...emptySession(), loadState: id ? 'loading' as const : 'ready' as const }
    sessions.current.set(key, next)
    selectedKey.current = key; setSelectedId(id || undefined)
    activeRef.current = next; setActive(next)
  }

  return {
    sourceName: 'SQL', embedded, onClose, error, busy: busy || editorDisabled, editorDisabled, tidy,
    items: items.map(item => ({ id: item.id, title: item.title, subtitle: item.tags.join(' · ') || item.dialect, summary: item.summary })),
    selectedId, search: query, onSearch: setQuery, onSearchSubmit: () => { void loadList(query) }, searchLabel: '检索经验',
    draftLabel: '＋ 新建', archiveLabel: '删除', empty: '还没有已发布模板。',
    onSelect: id => selectSession(id),
    title: active.title, summary: active.summary, tags: active.tags,
    onTitle: value => editSession(sessionKey(selectedId), { title: value }),
    onSummary: value => editSession(sessionKey(selectedId), { summary: value }),
    onTags: value => editSession(sessionKey(selectedId), { tags: value }),
    onRun: () => { void execute() }, onSave: () => { void saveToDisk() }, onUse: () => { if (activeRef.current.loadState === 'ready' && onApply && selectedKey.current !== '__draft__') onApply(activeRef.current.sql) },
    onArchive: (id, event) => { void archiveItem(id, event) },
    analysis: <>
        {active.loadState === 'loading' && <p role="status">正在读取经验…</p>}
        {active.loadState === 'error' && <button type="button" onClick={() => selectSession(selectedId || '', true)}>重新读取</button>}
        {(active.lineageAmbiguous || active.archived) && <p className="db-info-note">{active.archived ? '条目已归档，草稿已保留。' : '历史版本关系不明确，内容已保留。'}<button type="button" disabled={busy} onClick={() => void publishDraft({ publishAction: 'create' })}>另存为新模板</button></p>}
        {selectedId && active.loadState === 'ready' && <button type="button" disabled={busy} onClick={() => selectSession(selectedId, true)}>{active.dirty ? '重新加载（保留草稿）' : '重新加载'}</button>}
        <DraftRecovery drafts={sessions.current.recoverable(active.token)} disabled={busy} onRestore={token => {
          const preserved = sessions.current.byToken(token)!
          if (shouldRetainDraft(activeRef.current)) sessions.current.keep(activeRef.current)
          sessions.current.recovered(token); ++loadSeq.current
          const restoredKey = sessionKey(preserved.base?.id)
          sessions.current.set(restoredKey, preserved); selectedKey.current = restoredKey; setSelectedId(preserved.base?.id)
          activeRef.current = preserved; setActive(preserved); setError('已恢复草稿；保存时仍会校验原版本。')
          setSelectionEpoch(value => value + 1)
        }} />
        {active.parseNote && <p className="db-info-note">{active.parseNote}</p>}
        {!!active.similar.length && <div className="db-template-similar db-info-note"><strong>相似模板</strong>{active.similar.filter(hit => hit.score < 0.97).map(hit => <p key={hit.id}>{hit.title} · {(hit.score * 100).toFixed(0)}% · {hit.reasons.join('；')}
          <button type="button" disabled={busy} onClick={() => void publishSimilar('mergeMeta', hit)}>合并元数据</button>
          <button type="button" disabled={busy} onClick={() => void publishSimilar('newVersion', hit)}>新版本</button>
          <button type="button" disabled={busy} onClick={() => void publishSimilar('variant', hit)}>变体</button>
        </p>)}</div>}
</>,
    execution: editorDisabled ? <p className="db-info-note">{active.loadState === 'loading' ? '正在读取经验…' : '读取失败，请重新读取。'}</p> : connection?.live && schema && cache ? <SqlRunWorkspace
          connection={connection}
          schema={schema}
          cache={cache}
          sql={active.sql}
          onChange={sql => editSession(sessionKey(selectedId), { sql })}
          onSelectionChange={setSelection}
          onCursorChange={offset => { cursorRef.current = offset }}
          onRun={(text, mode) => { void execute(text, mode) }}
          onExplain={text => { void explain(text) }}
          busy={busy}
          runProgress={executing ? runs.current.current?.owner === active.token ? formatSqlBatchStatus(active.steps, true) : '其他草稿正在执行…' : undefined}
          hasSelection={!!selection.trim()}
          onCancel={() => {
            const ticket = runs.current.current
            if (!ticket) return
            const owner = sessions.current.byToken(ticket.owner)
            if (owner?.executionSnapshot) {
              const next = { ...owner, executionSnapshot: { ...owner.executionSnapshot, status: 'stopping' as const } }
              sessions.current.update(next)
              if (activeRef.current.token === owner.token) { activeRef.current = next; setActive(next) }
            }
            runs.current.stop()
          }}
          onSave={() => void saveToDisk()}
          onApply={onApply && selectedId ? () => onApply(active.sql) : undefined}
          editorRatio={active.ratio}
          onRatioChange={ratio => persistSession(sessionKey(selectedId), { ratio })}
          resultOpen={active.resultOpen}
          onResultOpenChange={open => persistSession(sessionKey(selectedId), { resultOpen: open })}
          actions={{
            run: true, cancel: executing, format: true, clear: true, save: true, explain: true,
            applyToQuery: !!(onApply && selectedId), ai: false,
          }}
          toolbarExtra={onSchemaChange ? <SqlToolbarSchemaTable
            connection={connection}
            schema={schema}
            schemas={schemaList}
            cache={cache}
            onSchemaChange={onSchemaChange}
            picked={picked}
            onPickTable={pickTable}
          /> : undefined}
          onClear={() => editSession(sessionKey(selectedId), { sql: '', steps: [], activeStep: 0, message: '', pane: 'message', resultOpen: false })}
          editorExtra={showStructure && picked && schema ? <TableStructurePane onClose={() => setShowStructure(false)} cache={cache} connection={connection} schema={schema} table={picked} /> : undefined}
          resultFrame={<QueryResultFrame
            secondaryHeader={<KnowledgeExecutionSnapshotView snapshot={active.executionSnapshot} text={active.sql} />}
            pane={active.pane}
            onPaneChange={pane => persistSession(sessionKey(selectedId), { pane })}
            resultTabs={active.steps.length > 1 ? active.steps.map((_, index) => ({ key: String(index), label: resultTabLabel(index, active.steps.length) })) : undefined}
            activeResultTab={String(active.activeStep)}
            onResultTabChange={key => persistSession(sessionKey(selectedId), { activeStep: Number(key), pane: 'result' })}
            summary={shown && active.pane === 'result' ? <strong>{shown.columns.length ? `${shown.rows.length} 行 · ${shown.elapsedMs} ms` : (shown.message || `${shown.elapsedMs} ms`)}</strong> : executing && runs.current.current?.owner === active.token ? <span className="db-muted" role="status">{formatSqlBatchStatus(active.steps, true) || '正在执行…'}</span> : undefined}
            actions={shown?.columns.length ? <ResultExportButtons result={shown} /> : undefined}
            message={active.steps.length ? <SqlReceipts localSteps={active.steps} /> : <pre className="db-cell-detail">{active.message}</pre>}
          >
            {shown ? <ReadonlyResultGrid result={shown} /> : step ? <pre className="db-cell-detail">{step.error || step.result?.message || (step.status === 'skipped' ? '未执行' : step.status === 'pending' || step.status === 'running' ? '执行中…' : '无结果集')}</pre> : null}
          </QueryResultFrame>}
        /> : <p className="db-info-note">请先连接数据库后再执行经验 SQL。</p>,
  }
}

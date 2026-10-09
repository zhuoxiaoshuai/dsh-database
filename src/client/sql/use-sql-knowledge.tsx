import type { KnowledgeLibraryProps } from '../workspace/knowledge/knowledge-library.tsx'
import React, { useEffect, useRef, useState } from 'react'
import { ReadonlyResultGrid, ResultExportButtons, resultSummary } from '../results.tsx'
import { SqlRunWorkspace } from '../sql-run-workspace.tsx'
import { QueryResultFrame } from '../workspace/source/query-result-frame.tsx'
import { TableStructurePane } from '../table-structure-pane.tsx'
import { SqlToolbarSchemaTable } from '../sql-toolbar-schema-table.tsx'
import type { SchemaCache } from '../schema/schema-cache.ts'
import type { Connection, Result, WorkspaceBridge } from '../../shared/workbench.ts'
import { stripLeadingComments, unwrapExplainSql, wrapExplainSql } from '../../shared/sql-text.ts'
import { SQL_SPLIT_RATIO_DEFAULT } from '../sql-pane-layout.ts'

type TemplateSummary = {
  id: string
  familyId: string
  version: number
  title: string
  summary: string
  tags: string[]
  dialect: string
  originalSql?: string
  features?: { operation?: string; tables?: string[]; risk?: string; parseOk?: boolean }
}

type SimilarHit = { id: string; title: string; score: number; reasons: string[]; version: number }

type Session = {
  sql: string
  title: string
  summary: string
  tags: string
  similar: SimilarHit[]
  parseNote: string
  message: string
  result?: Result
  ratio: number
  resultOpen: boolean
}

const emptySession = (): Session => ({
  sql: '',
  title: '',
  summary: '',
  tags: '',
  similar: [],
  parseNote: '',
  message: '',
  ratio: SQL_SPLIT_RATIO_DEFAULT,
  resultOpen: false,
})

function sessionKey(id?: string): string {
  return id || '__draft__'
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
}

export function useSqlKnowledge({
  bridge, connection, schema, schemas, cache, initialSql, focusTemplateId, onClose, onApply, onSaved, onSchemaChange, embedded, reloadKey,
}: SqlKnowledgeProps): KnowledgeLibraryProps {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<TemplateSummary[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState('')
  const [showStructure, setShowStructure] = useState(false)
  const sessions = useRef(new Map<string, Session>())
  const [active, setActive] = useState<Session>(() => ({
    ...emptySession(),
    sql: initialSql || '',
  }))
  const searchSeq = useRef(0)
  const previewSeq = useRef(0)
  const running = useRef<AbortController | null>(null)
  const dialect = connection?.dialect || 'mysql'
  const connectionId = connection?.id || ''
  const schemaList = schemas || []
  const identity = `${connectionId}\0${connection?.generation || ''}`
  const identityRef = useRef(identity)
  identityRef.current = identity
  const targetRef = useRef(schema)
  targetRef.current = schema
  const selectedKey = useRef(sessionKey(selectedId))
  selectedKey.current = sessionKey(selectedId)
  const activeRef = useRef(active)
  activeRef.current = active
  const editVersions = useRef(new Map<string, number>())
  const versionFor = (key: string) => editVersions.current.get(key) || 0
  const currentDraft = (key: string, version: number) => identityRef.current === identity && selectedKey.current === key && versionFor(key) === version

  const persistSession = (key: string, patch: Partial<Session>) => {
    const prev = sessions.current.get(key) || (selectedKey.current === key ? activeRef.current : emptySession())
    const next = { ...prev, ...patch }
    sessions.current.set(key, next)
    if (selectedKey.current === key) setActive(next)
  }
  const editSession = (key: string, patch: Partial<Session>) => {
    editVersions.current.set(key, versionFor(key) + 1)
    persistSession(key, patch)
  }

  const loadList = async (text = query) => {
    const seq = ++searchSeq.current
    try {
      if (!connectionId) { setItems([]); return }
      const result = await bridge.templates!('template-search', { query: text, dialect, connectionId }) as { items?: TemplateSummary[] }
      if (seq !== searchSeq.current || identityRef.current !== identity) return
      setItems(result.items || [])
      setError('')
    } catch (e) {
      if (seq !== searchSeq.current || identityRef.current !== identity) return
      setError(e instanceof Error ? e.message : '无法检索模板')
    }
  }

  useEffect(() => {
    void loadList('')
  }, [bridge, connectionId, connection?.generation, dialect, reloadKey])

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadList(query) }, 300)
    return () => window.clearTimeout(timer)
  }, [query, bridge, connectionId, dialect])

  useEffect(() => {
    if (!focusTemplateId) return
    setSelectedId(focusTemplateId)
  }, [focusTemplateId])

  useEffect(() => {
    if (!selectedId) return
    const key = sessionKey(selectedId)
    const cached = sessions.current.get(key)
    if (cached) { setActive(cached); return }
    let alive = true
    void bridge.templates!('template-get', { id: selectedId, connectionId }).then(raw => {
      if (!alive || identityRef.current !== identity || selectedKey.current !== key) return
      const item = raw as TemplateSummary & { originalSql?: string }
      const loaded: Session = {
        sql: item.originalSql || '',
        title: item.title || '',
        summary: item.summary || '',
        tags: (item.tags || []).join(', '),
        similar: [],
        parseNote: '',
        message: '',
        ratio: SQL_SPLIT_RATIO_DEFAULT,
        resultOpen: false,
      }
      sessions.current.set(key, loaded)
      setActive(loaded)
      void refreshPreview(loaded.sql, key)
    }).catch(e => { if (alive && identityRef.current === identity && selectedKey.current === key) setError(e instanceof Error ? e.message : '无法读取模板') })
    return () => { alive = false }
  }, [selectedId, bridge, connection?.generation])

  const refreshPreview = async (sql: string, key: string) => {
    if (!sql.trim()) return
    const seq = ++previewSeq.current
    const version = versionFor(key)
    try {
      if (!connectionId) return
      const result = await bridge.templates!('template-preview', { sql, dialect, connectionId }) as {
        draft?: { suggestedTitle?: string; suggestedSummary?: string; suggestedTags?: string[]; features?: { parseOk?: boolean } }
        similar?: SimilarHit[]
      }
      if (seq !== previewSeq.current || !currentDraft(key, version)) return
      const prev = sessions.current.get(key) || active
      persistSession(key, {
        title: prev.title || result.draft?.suggestedTitle || '',
        summary: prev.summary || result.draft?.suggestedSummary || '',
        tags: prev.tags || (result.draft?.suggestedTags || []).join(', '),
        similar: result.similar || [],
        parseNote: result.draft?.features?.parseOk === false ? '未能完整解析，相似合并需人工确认。' : '',
      })
    } catch (e) {
      if (seq !== previewSeq.current || !currentDraft(key, version)) return
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
      running.current?.abort()
      ++searchSeq.current; ++previewSeq.current
    }
  }, [identity])
  useEffect(() => { setBusy(false); setActive(previous => ({ ...previous, result: undefined, message: '' })) }, [identity])
  useEffect(() => {
    running.current?.abort(); running.current = null
    for (const [key, value] of sessions.current) sessions.current.set(key, { ...value, result: undefined, message: '' })
    setBusy(false); setActive(previous => ({ ...previous, result: undefined, message: '' }))
  }, [schema])

  const runSql = async (sqlText: string) => {
    if (!connection?.live || !schema || !sqlText.trim()) return
    running.current?.abort()
    const controller = new AbortController()
    const key = sessionKey(selectedId), version = versionFor(key)
    running.current = controller
    setBusy(true)
    try {
      const result = await bridge.execute({ ...connection, database: schema }, sqlText, controller.signal)
      if (identityRef.current === identity && targetRef.current === schema && versionFor(key) === version && !controller.signal.aborted) persistSession(key, { result, message: result.message || `成功 · ${result.rows.length} 行`, resultOpen: true })
    } catch (e) {
      if (identityRef.current === identity && targetRef.current === schema && versionFor(key) === version) persistSession(key, { result: undefined, message: e instanceof Error ? e.message : '执行失败', resultOpen: true })
    } finally {
      if (running.current === controller) { running.current = null; if (identityRef.current === identity) setBusy(false) }
    }
  }
  const run = () => void runSql(active.sql)
  const explain = () => {
    const text = active.sql
    const inner = stripLeadingComments(unwrapExplainSql(text))
    if (!/^(with\b[\s\S]*\bselect\b|select\b)/i.test(inner)) {
      persistSession(sessionKey(selectedId), { result: undefined, message: '解释仅支持 SELECT 查询。', resultOpen: true })
      return
    }
    void runSql(wrapExplainSql(dialect, text))
  }

  const publishSimilar = async (publishAction: string, targetId: string, expectedVersion: number) => {
    const origin = sessionKey(selectedId), version = versionFor(origin)
    setBusy(true); setError('')
    try {
      if (!connectionId) return
      await bridge.templates!('template-publish', {
        sql: active.sql,
        dialect,
        connectionId,
        title: active.title,
        summary: active.summary,
        tags: active.tags.split(/[,，\s]+/).filter(Boolean),
        publishAction,
        targetId,
        expectedVersion,
      })
      await loadList('')
      if (currentDraft(origin, version)) onSaved?.(targetId)
    } catch (e) { if (currentDraft(origin, version)) setError(e instanceof Error ? e.message : '保存失败') }
    finally { if (identityRef.current === identity) setBusy(false) }
  }

  const saveToDisk = async () => {
    if (!active.sql.trim()) return
    setBusy(true)
    setError('')
    const title = active.title.trim() || '未命名'
    const summary = active.summary.trim()
    const tags = active.tags.split(/[,，\s]+/).filter(Boolean)
    const selected = selectedId ? items.find(item => item.id === selectedId) : undefined
    const origin = sessionKey(selectedId), version = versionFor(origin), savedDraft = { ...active }
    try {
      if (!connectionId) throw new Error('请先选择连接。')
      const saved = await bridge.templates!('template-publish', {
        sql: active.sql,
        dialect,
        connectionId,
        title,
        summary,
        tags,
        publishAction: selected ? 'newVersion' : 'create',
        targetId: selected?.id,
        expectedVersion: selected?.version,
      }) as TemplateSummary
      const key = sessionKey(saved.id)
      if (identityRef.current !== identity) return
      if (currentDraft(origin, version)) {
        sessions.current.set(key, { ...savedDraft, title, summary, tags: tags.join(', '), resultOpen: savedDraft.resultOpen })
        setSelectedId(saved.id)
        setActive(sessions.current.get(key)!)
        onSaved?.(saved.id)
      }
      await loadList('')
    } catch (e) {
      if (currentDraft(origin, version)) setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      if (identityRef.current === identity) setBusy(false)
    }
  }

  const archiveItem = async (id: string, event: React.MouseEvent) => {
    const origin = sessionKey(selectedId), version = versionFor(origin)
    event.stopPropagation()
    setBusy(true)
    setError('')
    try {
      await bridge.templates!('template-archive', { id, connectionId })
      sessions.current.delete(sessionKey(id))
      if (identityRef.current !== identity) return
      if (selectedKey.current === sessionKey(id) && currentDraft(origin, version)) {
        const next = items.filter(item => item.id !== id)
        const neighbor = next[0]?.id
        if (neighbor) setSelectedId(neighbor)
        else {
          setSelectedId(undefined)
          const draft = emptySession()
          sessions.current.set(sessionKey(undefined), draft)
          setActive(draft)
        }
      }
      await loadList('')
    } catch (e) {
      if (currentDraft(origin, version)) setError(e instanceof Error ? e.message : '无法删除')
    } finally {
      if (identityRef.current === identity) setBusy(false)
    }
  }


  const pickTable = (name: string) => {
    setPicked(name)
    setShowStructure(!!name)
  }

  return {
    sourceName: 'SQL', embedded, onClose, error, busy,
    items: items.map(item => ({ id: item.id, title: item.title, subtitle: item.tags.join(' · ') || item.dialect, summary: item.summary })),
    selectedId, search: query, onSearch: setQuery, onSearchSubmit: () => { void loadList(query) }, searchLabel: '检索经验',
    draftLabel: '草稿', archiveLabel: '删除', empty: '还没有已发布模板。',
    onSelect: id => { setError(''); setSelectedId(id || undefined); if (!id) setActive(sessions.current.get('__draft__') || emptySession()) },
    title: active.title, summary: active.summary, tags: active.tags,
    onTitle: value => editSession(sessionKey(selectedId), { title: value }),
    onSummary: value => editSession(sessionKey(selectedId), { summary: value }),
    onTags: value => editSession(sessionKey(selectedId), { tags: value }),
    onRun: run, onSave: () => { void saveToDisk() }, onUse: () => { if (onApply && selectedId) onApply(active.sql) },
    onArchive: (id, event) => { void archiveItem(id, event) },
    analysis: <>        {active.parseNote && <p className="db-info-note">{active.parseNote}</p>}
        {!!active.similar.length && <div className="db-template-similar db-info-note"><strong>相似模板</strong>{active.similar.filter(hit => hit.score < 0.97).map(hit => <p key={hit.id}>{hit.title} · {(hit.score * 100).toFixed(0)}% · {hit.reasons.join('；')}
          <button type="button" disabled={busy} onClick={() => void publishSimilar('mergeMeta', hit.id, hit.version)}>合并元数据</button>
          <button type="button" disabled={busy} onClick={() => void publishSimilar('newVersion', hit.id, hit.version)}>新版本</button>
          <button type="button" disabled={busy} onClick={() => void publishSimilar('variant', hit.id, hit.version)}>变体</button>
        </p>)}</div>}
</>,
    execution: connection?.live && schema && cache ? <SqlRunWorkspace
          connection={connection}
          schema={schema}
          cache={cache}
          sql={active.sql}
          onChange={sql => editSession(sessionKey(selectedId), { sql })}
          onRun={() => run()}
          onExplain={() => explain()}
          busy={busy}
          onCancel={() => running.current?.abort()}
          onSave={() => void saveToDisk()}
          onApply={onApply && selectedId ? () => onApply(active.sql) : undefined}
          editorRatio={active.ratio}
          onRatioChange={ratio => persistSession(sessionKey(selectedId), { ratio })}
          resultOpen={active.resultOpen}
          onResultOpenChange={open => persistSession(sessionKey(selectedId), { resultOpen: open })}
          actions={{
            run: true, cancel: true, format: true, clear: true, save: true, explain: true,
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
          onClear={() => editSession(sessionKey(selectedId), { sql: '', result: undefined, message: '', resultOpen: false })}
          editorExtra={showStructure && picked && schema ? <TableStructurePane onClose={() => setShowStructure(false)} cache={cache} connection={connection} schema={schema} table={picked} /> : undefined}
          resultFrame={<QueryResultFrame
            pane={active.result ? 'result' : (active.message ? 'message' : 'result')}
            summary={active.result ? <span>{resultSummary(active.result, active.message)}</span> : undefined}
            actions={active.result ? <ResultExportButtons result={active.result} /> : undefined}
            message={active.message ? <p className={!active.result && active.message ? 'db-error' : 'db-muted db-result-inline-note'} role="status">{active.message}</p> : undefined}
          >
            {active.result ? <ReadonlyResultGrid result={active.result} /> : null}
          </QueryResultFrame>}
        /> : <p className="db-info-note">请先连接数据库后再执行经验 SQL。</p>,
  }
}

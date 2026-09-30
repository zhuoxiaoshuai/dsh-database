import React, { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { ReadonlyResultGrid, ResultExportButtons, resultSummary } from './results.tsx'
import { SqlRunWorkspace } from './sql-run-workspace.tsx'
import { QueryResultFrame } from './workspace/source/query-result-frame.tsx'
import { TableStructurePane } from './table-structure-pane.tsx'
import { SqlToolbarSchemaTable } from './sql-toolbar-schema-table.tsx'
import type { SchemaCache } from './schema/schema-cache.ts'
import type { Connection, Result, WorkspaceBridge } from '../shared/workbench.ts'
import { stripLeadingComments, unwrapExplainSql, wrapExplainSql } from '../shared/sql-text.ts'
import { KnowledgeLayout } from './workspace/knowledge/knowledge-layout.tsx'
import { KnowledgeItemList, KnowledgeMetadataFields } from './workspace/knowledge/knowledge-parts.tsx'
import { SQL_SPLIT_RATIO_DEFAULT } from './sql-pane-layout.ts'

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

export function SqlTemplateLibrary({
  bridge, connection, schema, schemas, cache, initialSql, focusTemplateId, onClose, onApply, onSaved, onSchemaChange, embedded, reloadKey,
}: {
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
}) {
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

  const persistSession = (key: string, patch: Partial<Session>) => {
    const prev = sessions.current.get(key) || active
    const next = { ...prev, ...patch }
    sessions.current.set(key, next)
    if (sessionKey(selectedId) === key) setActive(next)
  }

  const loadList = async (text = query) => {
    const seq = ++searchSeq.current
    try {
      if (!connectionId) { setItems([]); return }
      const result = await bridge.templates!('template-search', { query: text, dialect, connectionId }) as { items?: TemplateSummary[] }
      if (seq !== searchSeq.current) return
      setItems(result.items || [])
      setError('')
    } catch (e) {
      if (seq !== searchSeq.current) return
      setError(e instanceof Error ? e.message : '无法检索模板')
    }
  }

  useEffect(() => {
    void loadList('')
  }, [bridge, connectionId, dialect, reloadKey])

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
      if (!alive) return
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
    }).catch(e => { if (alive) setError(e instanceof Error ? e.message : '无法读取模板') })
    return () => { alive = false }
  }, [selectedId, bridge])

  const refreshPreview = async (sql: string, key: string) => {
    if (!sql.trim()) return
    const seq = ++previewSeq.current
    try {
      if (!connectionId) return
      const result = await bridge.templates!('template-preview', { sql, dialect, connectionId }) as {
        draft?: { suggestedTitle?: string; suggestedSummary?: string; suggestedTags?: string[]; features?: { parseOk?: boolean } }
        similar?: SimilarHit[]
      }
      if (seq !== previewSeq.current) return
      const prev = sessions.current.get(key) || active
      persistSession(key, {
        title: prev.title || result.draft?.suggestedTitle || '',
        summary: prev.summary || result.draft?.suggestedSummary || '',
        tags: prev.tags || (result.draft?.suggestedTags || []).join(', '),
        similar: result.similar || [],
        parseNote: result.draft?.features?.parseOk === false ? '未能完整解析，相似合并需人工确认。' : '',
      })
    } catch (e) {
      if (seq !== previewSeq.current) return
      setError(e instanceof Error ? e.message : '无法分析 SQL')
    }
  }

  useEffect(() => {
    const key = sessionKey(selectedId)
    const timer = window.setTimeout(() => { void refreshPreview(active.sql, key) }, 400)
    return () => window.clearTimeout(timer)
  }, [active.sql, connectionId, dialect, bridge, selectedId])

  useEffect(() => () => { running.current?.abort() }, [])

  const runSql = async (sqlText: string) => {
    if (!connection?.live || !schema || !sqlText.trim()) return
    running.current?.abort()
    const controller = new AbortController()
    running.current = controller
    setBusy(true)
    try {
      const result = await bridge.execute({ ...connection, database: schema }, sqlText, controller.signal)
      persistSession(sessionKey(selectedId), { result, message: result.message || `成功 · ${result.rows.length} 行`, resultOpen: true })
    } catch (e) {
      persistSession(sessionKey(selectedId), { result: undefined, message: e instanceof Error ? e.message : '执行失败', resultOpen: true })
    } finally {
      running.current = null
      setBusy(false)
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
      onSaved?.(targetId)
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败') }
    finally { setBusy(false) }
  }

  const saveToDisk = async () => {
    if (!active.sql.trim()) return
    setBusy(true)
    setError('')
    const title = active.title.trim() || '未命名'
    const summary = active.summary.trim()
    const tags = active.tags.split(/[,，\s]+/).filter(Boolean)
    const selected = selectedId ? items.find(item => item.id === selectedId) : undefined
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
      sessions.current.set(key, { ...active, title, summary, tags: tags.join(', '), resultOpen: active.resultOpen })
      setSelectedId(saved.id)
      setActive(sessions.current.get(key)!)
      await loadList('')
      onSaved?.(saved.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const archiveItem = async (id: string, event: React.MouseEvent) => {
    event.stopPropagation()
    setBusy(true)
    setError('')
    try {
      await bridge.templates!('template-archive', { id, connectionId })
      sessions.current.delete(sessionKey(id))
      if (selectedId === id) {
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
      setError(e instanceof Error ? e.message : '无法删除')
    } finally {
      setBusy(false)
    }
  }


  const pickTable = (name: string) => {
    setPicked(name)
    setShowStructure(!!name)
  }

  return <KnowledgeLayout label="SQL 经验库" embedded={embedded} error={error} onClose={onClose}
    listHeader={<>
          <strong>经验库</strong>
          <form className="db-template-list-search" onSubmit={e => { e.preventDefault(); void loadList(query) }}>
            <Search size={14} aria-hidden />
            <input aria-label="检索经验" placeholder="搜索" value={query} onChange={e => setQuery(e.target.value)} />
          </form>
          <button type="button" className="db-text-button" onClick={() => { setSelectedId(undefined); setActive(sessions.current.get('__draft__') || emptySession()) }}>草稿</button>
    </>}
    listBody={<>
          <KnowledgeItemList items={items.map(item => ({ id: item.id, title: item.title, subtitle: item.tags.join(' · ') || item.dialect, summary: item.summary }))}
            selectedId={selectedId} busy={busy} empty="还没有已发布模板。" archiveLabel="删除"
            onSelect={id => setSelectedId(id)} onArchive={(id, event) => void archiveItem(id, event)} />
    </>}
  >
        <KnowledgeMetadataFields title={active.title} summary={active.summary} tags={active.tags}
          onTitle={value => persistSession(sessionKey(selectedId), { title: value })}
          onSummary={value => persistSession(sessionKey(selectedId), { summary: value })}
          onTags={value => persistSession(sessionKey(selectedId), { tags: value })} />
        {active.parseNote && <p className="db-info-note">{active.parseNote}</p>}
        {!!active.similar.length && <div className="db-template-similar db-info-note"><strong>相似模板</strong>{active.similar.filter(hit => hit.score < 0.97).map(hit => <p key={hit.id}>{hit.title} · {(hit.score * 100).toFixed(0)}% · {hit.reasons.join('；')}
          <button type="button" disabled={busy} onClick={() => void publishSimilar('mergeMeta', hit.id, hit.version)}>合并元数据</button>
          <button type="button" disabled={busy} onClick={() => void publishSimilar('newVersion', hit.id, hit.version)}>新版本</button>
          <button type="button" disabled={busy} onClick={() => void publishSimilar('variant', hit.id, hit.version)}>变体</button>
        </p>)}</div>}
        {connection?.live && schema && cache ? <SqlRunWorkspace
          connection={connection}
          schema={schema}
          cache={cache}
          sql={active.sql}
          onChange={sql => persistSession(sessionKey(selectedId), { sql })}
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
          onClear={() => persistSession(sessionKey(selectedId), { sql: '', result: undefined, message: '', resultOpen: false })}
          editorExtra={showStructure && picked && schema ? <TableStructurePane cache={cache} connection={connection} schema={schema} table={picked} /> : undefined}
          resultFrame={<QueryResultFrame
            pane={active.result ? 'result' : (active.message ? 'message' : 'result')}
            summary={active.result ? <span>{resultSummary(active.result, active.message)}</span> : undefined}
            actions={active.result ? <ResultExportButtons result={active.result} /> : undefined}
            message={active.message ? <p className={!active.result && active.message ? 'db-error' : 'db-muted db-result-inline-note'} role="status">{active.message}</p> : undefined}
          >
            {active.result ? <ReadonlyResultGrid result={active.result} /> : null}
          </QueryResultFrame>}
        /> : <p className="db-info-note">请先连接数据库后再执行经验 SQL。</p>}
  </KnowledgeLayout>
}

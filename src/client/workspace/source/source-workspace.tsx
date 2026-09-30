import React, { useEffect, useRef, useState } from 'react'
import { Play, Square } from 'lucide-react'
import type { Connection, WorkspaceBridge } from '../../../shared/workbench.ts'
import { WorkspaceTabs } from './workspace-tabs.tsx'
import { ExecutionWorkbench } from './execution-workbench.tsx'
import { QueryResultFrame } from './query-result-frame.tsx'
import { AiQueryFrame } from '../../ai-executions.tsx'
import { AiControlBar } from './ai-control-bar.tsx'
import { useExecutionDocument } from './use-execution-document.ts'
import { useKnowledgeLibrary } from '../knowledge/use-knowledge-library.ts'
import { KnowledgeLibrary } from '../knowledge/knowledge-library.tsx'

type EditorProps = { value: string; onChange(value: string): void; onRun(value: string): void; editorContext?: unknown }
type ResultProps = { result?: any; onUse?(text: string): void }

/** Shared tabs, execution layout, AI document and knowledge flow. Sources only supply content and protocol operations. */
export function SourceWorkspace({ bridge, connection, sourceName, overview, Editor, Result, runText, hint, queryTabLabel = '查询', initialQuery = '', queryFooter, status, editorContext, executionContext = {}, executionContextKey = '', executionContextLabel }: {
  bridge: WorkspaceBridge
  connection: Connection
  sourceName: string
  overview(onUse: (text: string) => void): React.ReactNode
  Editor: React.ComponentType<EditorProps>
  Result: React.ComponentType<ResultProps>
  runText(text: string, signal?: AbortSignal): Promise<unknown>
  hint?(text: string): string | undefined
  queryTabLabel?: string
  initialQuery?: string
  queryFooter?(setText: (value: string) => void): React.ReactNode
  status?: string
  editorContext?: unknown
  executionContext?: Record<string, string>
  executionContextKey?: string
  executionContextLabel?: string
}): React.ReactElement {
  const [active, setActive] = useState('overview')
  const [queryText, setQueryText] = useState(initialQuery)
  const [queryResult, setQueryResult] = useState<unknown>()
  const [queryError, setQueryError] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef<{ controller: AbortController; sequence: number } | null>(null)
  const sequence = useRef(0)
  const requestIdentity = `${connection.id}\0${connection.generation || ''}\0${executionContextKey}`
  const requestIdentityRef = useRef(requestIdentity)
  requestIdentityRef.current = requestIdentity
  const [resultOpen, setResultOpen] = useState(false)
  const [aiResultOpen, setAiResultOpen] = useState(false)
  const document = useExecutionDocument(bridge, connection, executionContext, executionContextKey)
  const useForQuery = (text: string) => { setQueryText(text); setActive('query'); setQueryResult(undefined); setQueryError('') }
  const run = async (text: string) => {
    if (!connection.live || busy) return
    const controller = new AbortController()
    const current = ++sequence.current
    const owner = requestIdentity
    pending.current = { controller, sequence: current }
    setBusy(true); setQueryError(''); setResultOpen(true)
    try {
      const reply = await runText(text, controller.signal)
      if (current === sequence.current && requestIdentityRef.current === owner && !controller.signal.aborted) setQueryResult(reply)
    } catch (caught) {
      if (current === sequence.current && requestIdentityRef.current === owner) {
        setQueryError(controller.signal.aborted ? '已停止本次请求；服务端操作可能仍在结束中。' : caught instanceof Error ? caught.message : '执行失败。')
        setQueryResult(undefined)
      }
    } finally {
      if (current === sequence.current && requestIdentityRef.current === owner) { pending.current = null; setBusy(false) }
    }
  }
  const stop = () => {
    if (!pending.current) return
    pending.current.controller.abort()
    pending.current = null
    ++sequence.current
    setBusy(false)
    setQueryError('已停止本次请求；服务端操作可能仍在结束中。')
  }
  const knowledge = useKnowledgeLibrary(bridge, connection, active === 'knowledge', (text, signal) => runText(text, signal), useForQuery, executionContextKey)
  useEffect(() => {
    return () => { pending.current?.controller.abort(); pending.current = null; ++sequence.current }
  }, [connection.id, connection.generation, executionContextKey])
  useEffect(() => { setQueryResult(undefined); setQueryError(''); setBusy(false) }, [executionContextKey])
  useEffect(() => { setActive('overview'); setQueryText(initialQuery); setQueryResult(undefined); setQueryError(''); setBusy(false) }, [connection.id, connection.generation, initialQuery])
  useEffect(() => { if (document.error) setAiResultOpen(true) }, [document.error])
  const editor = (value: string, onChange: (text: string) => void, onRun: (text: string) => void) => <div className="db-command-row"><Editor value={value} onChange={onChange} onRun={onRun} editorContext={editorContext} /></div>
  const result = (value: unknown) => <Result result={value} onUse={useForQuery} />
  const alert = (text: string) => <p role="alert" className="db-error">{text}</p>
  const hintText = hint?.(queryText)
  return <div className="db-source-workspace" aria-label={`${sourceName} 工作区`}>
      <WorkspaceTabs label={`${sourceName} 页签`} tabs={[{ id: 'overview', label: '总览' }, { id: 'query', label: queryTabLabel }, { id: 'ai', label: 'AI Query' }, { id: 'knowledge', label: '经验库' }]} active={active} onActivate={setActive} />
      {active !== 'overview' && executionContextLabel && <p className="db-muted" aria-label="当前执行目标">{executionContextLabel}</p>}
      {active === 'overview' && <div className="db-source-overview">{overview(useForQuery)}</div>}
      {active === 'query' && <><ExecutionWorkbench className="db-sql-run-workspace db-command-console" resultOpen={resultOpen} onResultOpenChange={setResultOpen}
        toolbar={<div className="db-catalog-tools db-sql-toolbar"><button className="db-sql-toolbar-btn db-primary" type="button" disabled={busy || !connection.live} onClick={() => void run(queryText)}><Play size={14} />{busy ? '执行中…' : '执行'}</button>{busy && <button className="db-sql-toolbar-btn" type="button" onClick={stop}><Square size={14} />停止</button>}</div>}
        rail={<button type="button" className="db-text-button" onClick={busy ? stop : () => void run(queryText)} disabled={!connection.live}>{busy ? '停止' : '执行'}</button>}
        editor={editor(queryText, setQueryText, text => void run(text))}
        result={<QueryResultFrame>{queryError ? alert(queryError) : queryResult ? result(queryResult) : undefined}</QueryResultFrame>} />
        {hintText && <p className="db-command-hint">{hintText}</p>}
        {queryFooter?.(setQueryText)}</>}
      {active === 'ai' && <AiQueryFrame bridge={bridge} connection={connection}>
        <div className="db-catalog-tools db-sql-toolbar"><AiControlBar controller={document.document.controller} connectionName={connection.name} target={sourceName}
          onTakeover={() => void document.takeOver()} onReturnAi={() => void document.returnToAi()} />{document.error && <button type="button" onClick={document.retrySave}>重试保存</button>}</div>
        <ExecutionWorkbench className="db-sql-run-workspace db-command-console" resultOpen={aiResultOpen} onResultOpenChange={setAiResultOpen}
          toolbar={<div className="db-catalog-tools db-sql-toolbar"><button className="db-sql-toolbar-btn db-primary" type="button" disabled={document.busy || !connection.live} onClick={() => { setAiResultOpen(true); void document.run() }}><Play size={14} />{document.busy ? '执行中…' : '执行当前内容'}</button></div>}
          editor={editor(document.text, document.edit, () => { setAiResultOpen(true); void document.run() })}
          result={<QueryResultFrame>{document.error ? alert(document.error) : document.reply ? result(document.reply) : undefined}</QueryResultFrame>} />
      </AiQueryFrame>}
      {active === 'knowledge' && <KnowledgeLibrary sourceName={sourceName} items={knowledge.items} selectedId={knowledge.selectedId} onSelect={knowledge.select}
        search={knowledge.search} onSearch={knowledge.setSearch} title={knowledge.title} onTitle={knowledge.setTitle} summary={knowledge.summary} onSummary={knowledge.setSummary}
        tags={knowledge.tags} onTags={knowledge.setTags} busy={knowledge.busy} error={knowledge.error} runError={knowledge.runError} canRun={!!knowledge.text.trim() && !!connection.live}
        onRun={() => void knowledge.tryRun()} onSave={() => void knowledge.save()} onArchive={id => void knowledge.archive(id)} onUse={knowledge.useForQuery}
        editor={editor(knowledge.text, knowledge.setText, () => void knowledge.tryRun())} result={knowledge.result ? result(knowledge.result) : null} />}
      <footer className="db-shell-status">{connection.environment.toUpperCase()} | {sourceName}{status ? ` | ${status}` : ''} | {connection.live ? '已连接' : '未连接'}</footer>
    </div>
}

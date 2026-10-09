import React, { useEffect, useRef, useState } from 'react'
import { Play, Square } from 'lucide-react'
import type { Connection, WorkspaceBridge } from '../../../shared/workbench.ts'
import { WorkspaceTabs, type WorkspaceTab } from './workspace-tabs.tsx'
import { useNavigationConfiguration, useWorkspaceNavigation, type NavigationConfig, type NavigationItem, type WorkspaceNavigation } from './workspace-navigation.ts'
import { ExecutionWorkbench } from './execution-workbench.tsx'
import { QueryResultFrame } from './query-result-frame.tsx'
import { StorageNotice } from './storage-notice.tsx'
import { AiQueryFrame } from '../../ai-executions.tsx'
import { AiControlBar } from './ai-control-bar.tsx'
import { useExecutionDocument } from './use-execution-document.ts'
import { useDocumentResultBus } from '../../ai-query-bus.ts'
import { useKnowledgeLibrary } from '../knowledge/use-knowledge-library.ts'
import { KnowledgeLibrary } from '../knowledge/knowledge-library.tsx'

type EditorProps = { value: string; onChange(value: string): void; onRun(value: string): void; editorContext?: unknown }
type ResultProps = { result?: any; onUse?(text: string): void }

export type SourcePages = NavigationConfig & {
  describe(item: NavigationItem): WorkspaceTab
  content(item: NavigationItem, active: boolean): React.ReactNode
  keepMounted?: boolean
  toolbar?: React.ReactNode
  notice?: React.ReactNode
  extra?: React.ReactNode
  status?: React.ReactNode
}

export type CommandWorkspaceProps = {
  sourceName: string
  overview(onUse: (text: string) => void): React.ReactNode
  Editor: React.ComponentType<EditorProps>
  Result: React.ComponentType<ResultProps>
  runText(text: string, signal?: AbortSignal): Promise<unknown>
  confirmDocumentRun?(text: string): boolean
  hint?(text: string): string | undefined
  queryTabLabel?: string
  initialQuery?: string
  queryFooter?(setText: (value: string) => void): React.ReactNode
  status?: string
  editorContext?: unknown
  executionContext?: Record<string, string>
  executionContextKey?: string
  executionContextLabel?: string
}

export type SourceWorkspaceProps = { bridge: WorkspaceBridge; connection: Connection; navigation?: WorkspaceNavigation } & (
  { sourceName: string; pages: SourcePages } | CommandWorkspaceProps
)

/** Sources supply page content; the shared frame owns navigation and containers. */
export function SourceWorkspace(props: SourceWorkspaceProps): React.ReactElement {
  return props.navigation ? <SourceWorkspaceBody {...props} navigation={props.navigation} /> : <LocalSourceWorkspace {...props} />
}

function LocalSourceWorkspace(props: SourceWorkspaceProps): React.ReactElement {
  const navigation = useWorkspaceNavigation()
  return <SourceWorkspaceBody {...props} navigation={navigation} />
}

function SourceWorkspaceBody(props: SourceWorkspaceProps & { navigation: WorkspaceNavigation }): React.ReactElement {
  const { navigation } = props
  return <><StorageNotice bridge={props.bridge} />{'pages' in props ? <ComposedWorkspace {...props} navigation={navigation} /> : <CommandWorkspace {...props} navigation={navigation} />}</>
}

function ComposedWorkspace({ connection, sourceName, pages, navigation }: { connection: Connection; sourceName: string; pages: SourcePages; navigation: WorkspaceNavigation }) {
  useNavigationConfiguration(navigation, pages, connection.id)
  return <WorkspaceFrame connection={connection} sourceName={sourceName} pages={pages} navigation={navigation} />
}

function WorkspaceFrame({ connection, sourceName, pages, navigation, tabsLabel }: { connection: Connection; sourceName: string; pages: SourcePages; navigation: WorkspaceNavigation; tabsLabel?: string }) {
  return <div className="db-source-workspace" aria-label={`${sourceName} 工作区`}>
    {pages.toolbar && <header className="db-shell-top">{pages.toolbar}</header>}
    <div className="db-shell-main">
      <WorkspaceTabs label={tabsLabel} tabs={navigation.tabs.map(pages.describe)} active={navigation.active} onActivate={navigation.setActive} onClose={navigation.close} />
      {pages.notice}
      {navigation.tabs.filter(item => pages.keepMounted || item.id === navigation.active).map(item =>
        <div key={item.id} hidden={item.id !== navigation.active} className="db-tab-body">{pages.content(item, item.id === navigation.active)}</div>)}
    </div>
    <footer className="db-shell-status">{connection.environment.toUpperCase()} | {sourceName} | {connection.live ? '已连接' : '未连接'}{pages.status}</footer>
    {pages.extra}
  </div>
}

function CommandWorkspace({ navigation, bridge, connection, sourceName, overview, Editor, Result, runText, confirmDocumentRun, hint, queryTabLabel = '查询', initialQuery = '', queryFooter, status, editorContext, executionContext = {}, executionContextKey = '', executionContextLabel }: CommandWorkspaceProps & { bridge: WorkspaceBridge; connection: Connection; navigation: WorkspaceNavigation }): React.ReactElement {
  const { active, setActive } = navigation
  useNavigationConfiguration(navigation, { initialItems: [{ id: 'overview' }, { id: 'query' }, { id: 'ai' }, { id: 'knowledge' }], initialActive: 'overview', fallback: 'overview' }, `${connection.id}:${connection.generation || ''}`)
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
  const results = useDocumentResultBus({ bridge, connection, document: document.document, unsaved: document.unsaved })
  const runDocument = () => {
    if (confirmDocumentRun && !confirmDocumentRun(document.text)) return
    setAiResultOpen(true)
    void document.run().then(results.accept)
  }
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
  const result = (value: unknown, readOnly = false) => <Result result={value} onUse={readOnly ? undefined : useForQuery} />
  const alert = (text: string) => <p role="alert" className="db-error">{text}</p>
  const hintText = hint?.(queryText)
  return <WorkspaceFrame connection={connection} sourceName={sourceName} navigation={navigation} tabsLabel={`${sourceName} 页签`} pages={{
    initialItems: [], initialActive: 'overview', fallback: 'overview',
    describe: item => ({ id: item.id, label: ({ overview: '总览', query: queryTabLabel, ai: 'AI Query', knowledge: '经验库' } as Record<string, string>)[item.id] }),
    status: status ? ` | ${status}` : undefined,
    content: () => <>
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
        <div className="db-catalog-tools db-sql-toolbar"><AiControlBar pending={document.controlling} controller={document.confirmedController} connectionName={connection.name} target={sourceName}
          onTakeover={() => void document.takeOver().catch(() => {})} onReturnAi={() => void document.returnToAi().catch(() => {})} />{document.saveFailed && <button type="button" onClick={document.retrySave}>重试保存</button>}</div>
        <ExecutionWorkbench className="db-sql-run-workspace db-command-console" resultKey={results.current?.executionId} resultOpen={aiResultOpen} onResultOpenChange={setAiResultOpen}
           toolbar={<div className="db-catalog-tools db-sql-toolbar"><button className="db-sql-toolbar-btn db-primary" type="button" disabled={document.busy || !connection.live} onClick={runDocument}><Play size={14} />{document.busy ? '执行中…' : '执行当前内容'}</button></div>}
           editor={editor(document.text, document.edit, runDocument)}
          result={<QueryResultFrame secondaryHeader={<>{document.error && alert(document.error)}{results.stale && results.current && <details className="db-result-snapshot"><summary>上次执行结果 · {Object.values(results.current.identity.context).join(' · ') || sourceName}</summary><pre>{results.current.identity.executedSql}</pre></details>}</>}>{results.current ? result(results.current.result, results.stale) : undefined}</QueryResultFrame>} />
      </AiQueryFrame>}
      {active === 'knowledge' && <KnowledgeLibrary sourceName={sourceName} items={knowledge.items.map(item => ({ id: item.id, title: item.title, summary: item.summary, subtitle: `${item.analysis.operation} · v${item.version}` }))} selectedId={knowledge.selectedId} onSelect={knowledge.select}
        analysis={<p className="db-info-note">未完成语义分析；当前仅按命令及参数原文指纹去重。保存不会执行，试运行时重新检查权限。</p>}
        search={knowledge.search} onSearch={knowledge.setSearch} title={knowledge.title} onTitle={knowledge.setTitle} summary={knowledge.summary} onSummary={knowledge.setSummary}
        tags={knowledge.tags} onTags={knowledge.setTags} busy={knowledge.busy} error={knowledge.error} runError={knowledge.runError} canRun={!!knowledge.text.trim() && !!connection.live}
        onRun={() => void knowledge.tryRun()} onSave={() => void knowledge.save()} onArchive={id => void knowledge.archive(id)} onUse={knowledge.useForQuery}
        editor={editor(knowledge.text, knowledge.setText, () => void knowledge.tryRun())} result={knowledge.result ? result(knowledge.result) : null} />}
    </>,
  }} />
}

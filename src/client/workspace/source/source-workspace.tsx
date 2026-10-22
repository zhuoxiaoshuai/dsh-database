import {WorkbenchTooltips} from '../parts/overlay/tooltip.tsx'
import React, { useEffect, useRef, useState } from 'react'
import { Play, Square } from 'lucide-react'
import type { Connection, WorkspaceBridge } from '../../../shared/workbench.ts'
import { WorkspaceTabs, type WorkspaceTab, type WorkspaceTaskAction } from '../parts/layout/workspace-tabs.tsx'
import { useNavigationConfiguration, useWorkspaceNavigation, type NavigationConfig, type NavigationItem, type WorkspaceNavigation } from './workspace-navigation.ts'
import { ExecutionWorkbench } from './execution-workbench.tsx'
import { QueryResultFrame } from '../parts/layout/query-result-frame.tsx'
import { StorageNotice } from './storage-notice.tsx'
import { AiQueryFrame } from '../../ai-executions.tsx'
import { AiControlBar } from './ai-control-bar.tsx'
import { useExecutionDocument } from './use-execution-document.ts'
import { useDocumentResultBus } from '../../ai-query-bus.ts'
import { useKnowledgeLibrary } from '../knowledge/use-knowledge-library.ts'
import { KnowledgeLibrary } from '../knowledge/knowledge-library.tsx'
import { useWorkbenchTheme } from '../parts/theme/use-workbench-theme.ts'
import { ResourceError } from '../parts/feedback/resource-error.tsx'

type EditorProps = { value: string; disabled?: boolean; onChange(value: string): void; onRun(value: string): void; editorContext?: unknown }
type ResultProps = { result?: any; onUse?(text: string): void }

/** Optional source-owned manual query behavior; navigation and draft stay shared. */
export type ManualQueryProps = {
  bridge: WorkspaceBridge
  connection: Connection
  value: string
  onChange(text: string): void
  onUse(text: string): void
  Result: React.ComponentType<ResultProps>
  editorContext?: unknown
}

export type SourcePages = NavigationConfig & {
  describe(item: NavigationItem): WorkspaceTab
  content(item: NavigationItem, active: boolean): React.ReactNode
  keepMounted?: boolean | 'visited'
  toolbar?: React.ReactNode
  taskActions?: readonly WorkspaceTaskAction[]
  notice?: React.ReactNode
  extra?: React.ReactNode
  status?: React.ReactNode
}

export type CommandWorkspaceProps = {
  sourceName: string
  overview(onUse: (text: string) => void): React.ReactNode
  Editor: React.ComponentType<EditorProps>
  ManualQuery?: React.ComponentType<ManualQueryProps>
  Result: React.ComponentType<ResultProps>
  runText(text: string, signal?: AbortSignal): Promise<unknown>
  confirmDocumentRun?(text: string): boolean | Promise<boolean>
  extra?: React.ReactNode
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
  return <><WorkbenchTooltips/><StorageNotice bridge={props.bridge} />{'pages' in props ? <ComposedWorkspace {...props} navigation={navigation} /> : <CommandWorkspace {...props} navigation={navigation} />}</>
}

function ComposedWorkspace({ connection, sourceName, pages, navigation }: { connection: Connection; sourceName: string; pages: SourcePages; navigation: WorkspaceNavigation }) {
  useNavigationConfiguration(navigation, pages, connection.id)
  return <WorkspaceFrame connection={connection} sourceName={sourceName} pages={pages} navigation={navigation} />
}

function WorkspaceFrame({ connection, sourceName, pages, navigation, tabsLabel }: { connection: Connection; sourceName: string; pages: SourcePages; navigation: WorkspaceNavigation; tabsLabel?: string }) {
  const theme = useWorkbenchTheme()
  const visited = useRef(new Set<string>())
  visited.current.add(navigation.active)
  return <div className="db-source-workspace" {...theme.attributes} style={theme.attributes['data-db-theme-mode'] === 'host' && theme.attributes['data-db-palette'] === 'mist-green' ? undefined : theme.style} aria-label={`${sourceName} 工作区`}>
    {pages.toolbar && <header className="db-shell-top">{pages.toolbar}</header>}
    <div className="db-shell-main">
      <WorkspaceTabs label={tabsLabel} tabs={navigation.tabs.map(pages.describe)} active={navigation.active} onActivate={navigation.setActive} onClose={navigation.close} actions={pages.taskActions} />
      {pages.notice}
      {navigation.tabs.filter(item => pages.keepMounted === true || item.id === navigation.active || (pages.keepMounted === 'visited' && visited.current.has(item.id))).map(item =>
        <div key={item.id} hidden={item.id !== navigation.active} className="db-tab-body">{pages.content(item, item.id === navigation.active)}</div>)}
    </div>
    <footer className="db-shell-status"><span title={connection.name}>{connection.name}</span> · {connection.environment.toUpperCase()} · {connection.live ? '已连接' : '未连接'}</footer>
    {pages.extra}
  </div>
}

function CommandWorkspace({ navigation, bridge, connection, sourceName, overview, Editor, ManualQuery, Result, runText, confirmDocumentRun, hint, queryTabLabel = '查询', initialQuery = '', queryFooter, status, editorContext, executionContext = {}, executionContextKey = '', executionContextLabel, extra }: CommandWorkspaceProps & { bridge: WorkspaceBridge; connection: Connection; navigation: WorkspaceNavigation }): React.ReactElement {
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
  const [resultOpen, setResultOpen] = useState(true)
  const [aiResultOpen, setAiResultOpen] = useState(true)
  const document = useExecutionDocument(bridge, connection, executionContext, executionContextKey)
  const results = useDocumentResultBus({ bridge, connection, document: document.document, unsaved: document.unsaved })
  const currentDocument=useRef(document);currentDocument.current=document
  const runDocument = async () => {
    const text=document.text,owner=requestIdentity
    if(confirmDocumentRun&&!await confirmDocumentRun(text))return
    if(requestIdentityRef.current!==owner||currentDocument.current.text!==text)return
    setAiResultOpen(true)
    void currentDocument.current.run().then(results.accept)
  }
  const useForQuery = (text: string) => { setQueryText(text); navigation.open({id:'query'}); setQueryResult(undefined); setQueryError('') }
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
  const editor = (value: string, onChange: (text: string) => void, onRun: (text: string) => void, disabled = false) => <div className="db-command-row"><Editor disabled={disabled} value={value} onChange={onChange} onRun={onRun} editorContext={editorContext} /></div>
  const result = (value: unknown, readOnly = false) => <Result result={value} onUse={readOnly ? undefined : useForQuery} />
  const alert = (text: string) => <ResourceError message={text}/>
  const hintText = hint?.(queryText)
  return <WorkspaceFrame connection={connection} sourceName={sourceName} navigation={navigation} tabsLabel={`${sourceName} 页签`} pages={{
    initialItems: [], initialActive: 'overview', fallback: 'overview',
    keepMounted: 'visited',
    describe: item => ({ id: item.id, label: ({ overview: '总览', query: queryTabLabel, ai: 'AI Query', knowledge: '经验库' } as Record<string, string>)[item.id], closable: item.id !== 'overview' }),
    taskActions: [{id:'query',label:queryTabLabel,onOpen:()=>navigation.open({id:'query'})},{id:'ai',label:'AI Query',onOpen:()=>navigation.open({id:'ai'})},{id:'knowledge',label:'经验库',onOpen:()=>navigation.open({id:'knowledge'})}],
    status: status ? ` | ${status}` : undefined,
    extra,
    content: item => <>
      {item.id !== 'overview' && executionContextLabel && <p className="db-context-line" aria-label="当前执行目标">{executionContextLabel}</p>}
      {item.id === 'overview' && <div className="db-source-overview">{overview(useForQuery)}</div>}
      {item.id === 'query' && (ManualQuery ? <ManualQuery key={requestIdentity} bridge={bridge} connection={connection} value={queryText} onChange={setQueryText} onUse={useForQuery} Result={Result} editorContext={editorContext} /> : <><ExecutionWorkbench className="db-sql-run-workspace db-command-console" resultKey={queryResult ? String(sequence.current) : queryError || undefined} resultOpen={resultOpen} onResultOpenChange={setResultOpen}
        toolbar={<div className="db-catalog-tools db-sql-toolbar"><button className="db-sql-toolbar-btn db-primary" type="button" disabled={busy || !connection.live} onClick={() => void run(queryText)}><Play size={14} />{busy ? '执行中…' : '执行'}</button>{busy && <button className="db-sql-toolbar-btn" type="button" onClick={stop}><Square size={14} />停止</button>}</div>}
        rail={<button type="button" className="db-text-button" onClick={busy ? stop : () => void run(queryText)} disabled={!connection.live}>{busy ? '停止' : '执行'}</button>}
        editor={editor(queryText, setQueryText, text => void run(text))}
        result={<QueryResultFrame>{queryError ? alert(queryError) : queryResult ? result(queryResult) : undefined}</QueryResultFrame>} />
        {hintText && <p className="db-command-hint">{hintText}</p>}
        {queryFooter?.(setQueryText)}</>)}
      {item.id === 'ai' && <AiQueryFrame bridge={bridge} connection={connection}>
        <div className="db-catalog-tools db-sql-toolbar"><AiControlBar pending={document.controlling} controller={document.confirmedController} connectionName={connection.name} target={sourceName}
          onTakeover={() => void document.takeOver().catch(() => {})} onReturnAi={() => void document.returnToAi().catch(() => {})} />{document.saveFailed && <button type="button" onClick={document.retrySave}>重试保存</button>}</div>
        <ExecutionWorkbench className="db-sql-run-workspace db-command-console" resultKey={results.current?.executionId} resultOpen={aiResultOpen} onResultOpenChange={setAiResultOpen}
           toolbar={<div className="db-catalog-tools db-sql-toolbar"><button className="db-sql-toolbar-btn db-primary" type="button" disabled={document.busy || !connection.live} onClick={runDocument}><Play size={14} />{document.busy ? '执行中…' : '执行当前内容'}</button></div>}
           editor={editor(document.text, document.edit, runDocument)}
          result={<QueryResultFrame secondaryHeader={<>{document.error && alert(document.error)}{results.stale && results.current && <details className="db-result-snapshot"><summary>上次执行结果 · {Object.values(results.current.identity.context).join(' · ') || sourceName}</summary><pre>{results.current.identity.executedSql}</pre></details>}</>}>{results.current ? result(results.current.result, results.stale) : undefined}</QueryResultFrame>} />
      </AiQueryFrame>}
      {item.id === 'knowledge' && <KnowledgeLibrary sourceName={sourceName} items={knowledge.items.map(item => ({ id: item.id, title: item.title, summary: item.summary, subtitle: `${item.analysis.operation} · v${item.version}` }))} selectedId={knowledge.selectedId} onSelect={knowledge.select}
        analysis={<>{knowledge.analysis}<p className="db-info-note">未完成语义分析；当前仅按命令及参数原文指纹去重。保存不会执行，试运行时重新检查权限。</p></>}
        search={knowledge.search} onSearch={knowledge.setSearch} title={knowledge.title} onTitle={knowledge.setTitle} summary={knowledge.summary} onSummary={knowledge.setSummary}
        tags={knowledge.tags} onTags={knowledge.setTags} busy={knowledge.busy} editorDisabled={knowledge.editorDisabled} error={knowledge.error} runError={knowledge.runError} canRun={!!knowledge.text.trim() && !!connection.live}
        onRun={() => void knowledge.tryRun()} onSave={() => void knowledge.save()} onArchive={id => void knowledge.archive(id)} onUse={knowledge.useForQuery} tidy={knowledge.tidy}
        executionInfo={knowledge.executionInfo} editor={editor(knowledge.text, knowledge.setText, () => void knowledge.tryRun(), knowledge.editorDisabled)} result={knowledge.result ? result(knowledge.result) : null} />}
    </>,
  }} />
}

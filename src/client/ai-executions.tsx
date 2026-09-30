import React, { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { AiCollabEditorPane, AiCollabRoot } from './ai-collab-pane.tsx'
import { PaneGutter, PANE_GUTTER } from './workspace/shell/pane-gutter.tsx'
import { SaveExperienceDialog } from './save-experience-dialog.tsx'
import { publishExperienceFromSql } from '../shared/publish-experience.ts'
import { AiStepChain } from './ai-step-chain.tsx'
import { useDragResize } from './workspace/parts/use-drag-resize.ts'
import type { SchemaCache } from './schema/schema-cache.ts'
import { EXECUTION_STATUS_LABELS, executionChain, executionOutcomeSummary, executionReason, executionTitle, groupExecutionsByLocalDay, historyItemsForConnection, isDisplayHistoryExecution, isTerminalStatus, type DisplayResult, type ExecutionRecord } from '../shared/execution.ts'
import { emptySharedQuery, type Connection, type SharedQuery, type WorkspaceBridge } from '../shared/workbench.ts'
import { activeExecution, useExecutionItems } from './ai-query-bus.ts'
import { executionDetailSource } from './workspace/source/execution-details.tsx'
import { previewJson } from './workspace/parts/preview-json.tsx'

function visibleHistory(items: ExecutionRecord[], connection?: Connection): ExecutionRecord[] {
  const source = executionDetailSource(connection?.dialect)
  return historyItemsForConnection(items, connection?.id, source?.legacyHistoryVisible)
}

type Draft = { kind: 'dml' | 'ddl' | 'query'; schema?: string; table?: string; sql?: string; operation?: Record<string, unknown>; operations?: Record<string, unknown>[] }

function elapsedLabel(item: ExecutionRecord): string {
  const ms = Date.parse(item.updatedAt) - Date.parse(item.createdAt)
  return Number.isFinite(ms) && ms >= 0 ? `${ms} ms` : ''
}

function clockLabel(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  return new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function ExecutionRecordDrawer({
  record, connection, bridge, onOpenDraft, onWriteSql, onClose, actionsEnabled,
}: {
  record: ExecutionRecord & { result?: unknown; resultMissing?: boolean }
  connection?: Connection
  bridge: WorkspaceBridge
  onOpenDraft?(draft: Draft, executionId: string): void
  onWriteSql?(sql: string, schema?: string): void
  onClose(): void
  actionsEnabled: boolean
}) {
  return <aside className="db-ai-drawer" aria-label="执行详情">
    <header className="db-ai-drawer-head">
      <strong>执行详情</strong>
      <button type="button" className="db-icon-button" aria-label="关闭详情" onClick={onClose}><X size={16} /></button>
    </header>
    <div className="db-ai-drawer-body">
      <div className="db-ai-record-card">
        <section className="db-ai-record-section db-ai-record-summary">
          <p className="db-ai-record-title">{executionTitle(record)}</p>
          <p className="db-ai-record-status" role="status">{EXECUTION_STATUS_LABELS[record.status]}</p>
          <p className="db-ai-record-outcome">{executionOutcomeSummary(record)}</p>
        </section>
        <div className="db-ai-record-actions">
          {!isTerminalStatus(record.status) && <button type="button" className="db-stop" onClick={() => void bridge.executions!('execution-cancel', { executionId: record.executionId })}>取消</button>}
        </div>
        {executionReason(record) && <section className="db-ai-record-section"><strong>原因</strong><p>{executionReason(record)}</p></section>}
        {executionDetailSource(record.dialect)?.renderText(record, onWriteSql) || <section className="db-ai-record-section"><strong>操作</strong><p>{record.operation}</p></section>}
        {record.result != null && <section className="db-ai-record-section"><strong>结果预览</strong>{(() => {
          const source = executionDetailSource(record.dialect)
          return source ? source.renderResult(source.resultEnvelope(record, record.result)) : previewJson(record.result)
        })()}</section>}
        {record.resultMissing && <section className="db-ai-record-section"><p className="db-muted">结果预览未保留。</p></section>}
        <section className="db-ai-record-section"><strong>执行事件</strong><p className="db-catalog-source">{record.initiator === 'user' ? '用户' : 'AI'} · {elapsedLabel(record) || '—'} · callId {record.callId || '（无）'} · executionId {record.executionId}</p><ol>{record.events.map((event, i) => <li key={i}>{event.kind} · {event.elapsedMs} ms{event.message ? ` · ${event.message}` : ''}</li>)}</ol></section>
        {!isDisplayHistoryExecution(record) && !record.historyVisible && !executionDetailSource(record.dialect)?.legacyHistoryVisible?.(record) && <section className="db-ai-record-section"><strong>工具调用</strong><p>{record.operation}</p></section>}
      </div>
    </div>
  </aside>
}

function AiExecutionChrome({
  label, hidden, items, error, emptyNote, connection, bridge, children, flushDetail, onOpenDraft, onWriteSql, focusId, onFocus, extra,
}: {
  label: string
  hidden?: boolean
  items: ExecutionRecord[]
  error?: string
  emptyNote: string
  connection?: Connection
  bridge: WorkspaceBridge
  children: React.ReactNode
  flushDetail?: boolean
  onOpenDraft?(draft: Draft, executionId: string): void
  onWriteSql?(sql: string, schema?: string): void
  focusId?: string
  onFocus?(id?: string): void
  extra?: React.ReactNode
}): React.ReactElement {
  const [selected, setSelected] = useState<string>()
  const [detail, setDetail] = useState<(ExecutionRecord & { result?: unknown; resultMissing?: boolean })>()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(() => new Set())
  const [listWidth, setListWidth] = useState(200)
  const [listCollapsed, setListCollapsed] = useState(false)
  const [detailWidth, setDetailWidth] = useState(320)
  const rootRef = useRef<HTMLDivElement>(null)
  const [availableWidth, setAvailableWidth] = useState(0)
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false)
  const compact = availableWidth > 0 && availableWidth < listWidth + 540
  const visibleListCollapsed = compact ? !historyDrawerOpen : listCollapsed

  useEffect(() => {
    const node = rootRef.current
    if (!node) return
    const measure = () => setAvailableWidth(node.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!compact) setHistoryDrawerOpen(false)
  }, [compact])

  const startListResize = useDragResize((start, next) => {
    setListWidth(Math.min(520, Math.max(180, listWidth + (next.clientX - start.clientX))))
  })

  const startDetailResize = useDragResize((start, next) => {
    setDetailWidth(Math.min(520, Math.max(260, detailWidth + (start.clientX - next.clientX))))
  })

  useEffect(() => {
    if (focusId) setSelected(focusId)
  }, [focusId])

  useEffect(() => {
    if (!selected || !bridge.executions) { setDetail(undefined); return }
    let alive = true
    void bridge.executions('execution-get', { executionId: selected }).then(value => {
      if (alive) setDetail(value as unknown as ExecutionRecord & { result?: unknown; resultMissing?: boolean })
    }).catch(() => { if (alive) setDetail(undefined) })
    return () => { alive = false }
  }, [bridge, selected, items])

  const listed = visibleHistory(items, connection)
  const dayGroups = groupExecutionsByLocalDay(listed)
  const toggleDay = (dayKey: string) => {
    setCollapsedDays(old => {
      const next = new Set(old)
      if (next.has(dayKey)) next.delete(dayKey)
      else next.add(dayKey)
      return next
    })
  }
  const current = listed.find(item => item.executionId === selected) || items.find(item => item.executionId === selected)
  const detailCurrent: (ExecutionRecord & { result?: unknown; resultMissing?: boolean }) | undefined = current && detail?.executionId === selected ? { ...current, ...detail } : current || detail
  const pick = (id: string) => {
    setSelected(id)
    onFocus?.(id)
  }
  const openDetail = (id: string) => { pick(id); setDrawerOpen(true); setHistoryDrawerOpen(false) }

  const gridColumns = compact ? `${PANE_GUTTER}px minmax(0, 1fr)` : drawerOpen
    ? `${listCollapsed ? PANE_GUTTER : listWidth}px minmax(0, 1fr) 7px ${detailWidth}px`
    : `${listCollapsed ? PANE_GUTTER : listWidth}px minmax(0, 1fr)`

  return <div ref={rootRef} className={`db-ai-executions${compact ? ' is-compact' : ''}`} hidden={hidden} aria-label={label} style={{ gridTemplateColumns: gridColumns }}>
    <div className={`db-ai-list${visibleListCollapsed ? ' is-collapsed' : ''}${compact && historyDrawerOpen ? ' is-drawer' : ''}`}>
      {!visibleListCollapsed && <>
      <div className="db-ai-list-head">
        <strong>执行历史</strong>
      </div>
      {error && <p className="db-error" role="alert">{error}</p>}
      {!listed.length && <p className="db-info-note">{emptyNote}</p>}
      {dayGroups.map(group => {
        const open = !collapsedDays.has(group.dayKey)
        return <section key={group.dayKey || group.label} className="db-ai-day">
          <button type="button" className="db-ai-day-head" aria-expanded={open} onClick={() => toggleDay(group.dayKey)}>
            <span>{group.label}</span>
            <small>{group.items.length}</small>
          </button>
          {open && group.items.map(item => {
            const time = clockLabel(item.createdAt)
            return <div key={item.executionId} className={`db-ai-item-row ${selected === item.executionId ? 'is-active' : ''}`}>
              <button type="button" className="db-ai-item-main" onClick={() => openDetail(item.executionId)}>
                <strong>{executionTitle(item)}</strong>
                <small>{EXECUTION_STATUS_LABELS[item.status]} · {item.connectionName || '未绑定连接'}{elapsedLabel(item) ? ` · ${elapsedLabel(item)}` : ''}</small>
              </button>
            {time && <time className="db-ai-item-time" dateTime={item.createdAt}>{time}</time>}
            </div>
          })}
        </section>
      })}
      </>}
      <PaneGutter
        axis="x"
        collapsed={visibleListCollapsed}
        onToggle={() => compact ? setHistoryDrawerOpen(false) : setListCollapsed(value => !value)}
        onExpand={() => compact ? setHistoryDrawerOpen(true) : setListCollapsed(false)}
        onResize={compact || visibleListCollapsed ? undefined : startListResize}
      />
    </div>
    <div className={`db-ai-detail${flushDetail ? ' is-flush' : ''}`}>{children}</div>
    {drawerOpen && <>
      {!compact && <div className="db-ai-drawer-resizer" role="separator" aria-orientation="vertical" aria-label="拖拽调整详情宽度" onPointerDown={startDetailResize} />}
      {detailCurrent ? <ExecutionRecordDrawer
        record={detailCurrent}
        connection={connection}
        bridge={bridge}
        onOpenDraft={onOpenDraft}
        onWriteSql={onWriteSql}
        onClose={() => setDrawerOpen(false)}
        actionsEnabled={!!connection?.live}
      /> : <aside className="db-ai-drawer"><p className="db-info-note">选择一条记录后查看详情。</p></aside>}
    </>}
    {extra}
  </div>
}

/** History belongs to AI Query. Workspaces pass only the AI editor, not the rest of the page. */
export function AiQueryFrame({ bridge, connection, children }: {
  bridge: WorkspaceBridge
  connection: Connection
  children: React.ReactNode
}): React.ReactElement {
  const { items, error } = useExecutionItems(bridge)
  return <AiExecutionChrome
    label="AI Query"
    items={items}
    error={error}
    emptyNote="还没有执行历史。此连接上的 AI 与人工执行会出现在这里。"
    connection={connection}
    bridge={bridge}
    flushDetail
  >{children}</AiExecutionChrome>
}

export function AiExecutions({
  bridge, connection, schema, schemas, cache, query, onQuery, focusId, onFocus, onOpenDraft, onWriteSql, items, display, onDisplay, markEditing, hidden, onRestoreSchema, onOpenTemplates, templateReloadKey, error,
}: {
  bridge: WorkspaceBridge
  connection?: Connection
  schema?: string
  schemas?: string[]
  cache?: SchemaCache
  query?: SharedQuery
  onQuery?(next: SharedQuery): void
  focusId?: string
  onFocus?(id?: string): void
  onOpenDraft?(draft: Draft, executionId: string): void
  onWriteSql?(sql: string, schema?: string): void
  items?: ExecutionRecord[]
  display?: DisplayResult
  onDisplay?(next?: DisplayResult): void
  markEditing?(value: boolean): void
  hidden?: boolean
  onRestoreSchema?(schemaName: string): void
  onOpenTemplates?(templateId?: string): void
  templateReloadKey?: number
  error?: string
}): React.ReactElement {
  const [focus, setFocus] = useState<string>()
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveBusy, setSaveBusy] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveSuccess, setSaveSuccess] = useState('')

  const listed = visibleHistory(items || [], connection)
  const current = listed.find(item => item.executionId === focus) || (items || []).find(item => item.executionId === focus)
  const chain = executionChain(listed, current)
  const stepChain = <AiStepChain chain={chain} selectedId={focus} onPick={id => { setFocus(id); onFocus?.(id) }} />
  const active = activeExecution(items || [], connection?.id)
  const canRunCollab = connection?.live && cache && onQuery
  const center = canRunCollab ? (
    <AiCollabRoot key={`${connection.id}:${connection.generation || ''}`} bridge={bridge} connection={connection} schema={schema || ''} cache={cache} query={query || emptySharedQuery()} onQuery={onQuery} schemas={schemas} onSchemaChange={onRestoreSchema} templateReloadKey={templateReloadKey} display={display} onDisplay={onDisplay} markEditing={markEditing} activeExecutionId={active?.executionId} active={!hidden}>
      <div className="db-ai-split">
        {stepChain}
        <div className="db-ai-editor-pane"><AiCollabEditorPane onSave={() => setSaveOpen(true)} /></div>
      </div>
    </AiCollabRoot>
  ) : (
    <div className="db-ai-split db-ai-split-fallback">
      {stepChain}
      {connection && !connection.live && <p className="db-info-note" role="status">当前连接未打开，请先双击连接后再运行 AI Query。</p>}
      {connection?.live && !cache && <p className="db-info-note" role="status">正在准备编辑器。</p>}
    </div>
  )

  return <AiExecutionChrome
      label="AI Query"
      hidden={hidden}
      items={items || []}
      error={error}
      emptyNote="还没有查询历史。AI 与用户在此连接上的查询、写入和执行计划会出现在这里。"
      connection={connection}
      bridge={bridge}
      onOpenDraft={onOpenDraft}
      onWriteSql={onWriteSql}
      focusId={focusId || focus}
      onFocus={id => { setFocus(id); onFocus?.(id) }}
      extra={connection && <SaveExperienceDialog
      open={saveOpen}
      busy={saveBusy}
      error={saveError}
      success={saveSuccess}
      onCancel={() => { setSaveOpen(false); setSaveError(''); setSaveSuccess('') }}
      onConfirm={name => {
        setSaveBusy(true)
        setSaveError('')
        setSaveSuccess('')
        void publishExperienceFromSql(bridge, { sql: query?.sql || '', dialect: connection.dialect, connectionId: connection.id, title: name }).then(outcome => {
          setSaveSuccess(outcome.merged ? '已合并到已有经验。' : '已创建新经验。')
          try { onOpenTemplates?.(outcome.id) } catch { /* 跳转失败不影响已保存 */ }
        }).catch(e => setSaveError(e instanceof Error ? e.message : '保存失败')).finally(() => setSaveBusy(false))
      }}
    />}
    >
      {center}
    </AiExecutionChrome>
}

export function AiActivityBanner({ items, onOpen, peer, onViewPeer, onDismissPeer }: {
  items: ExecutionRecord[]
  onOpen(id: string): void
  peer?: { connectionId: string; name?: string; status: string; executionId?: string }
  onViewPeer?(connectionId: string): void
  onDismissPeer?(): void
}): React.ReactElement | null {
  if (peer) {
    const name = peer.name || items.find(item => item.connectionId === peer.connectionId)?.connectionName
    const label = peer.status === 'running'
      ? `${name || '其他连接'} 正在查询`
      : `${name || '其他连接'} 的查询已完成`
    return <div className="db-info-note db-ai-peer-banner" role="status">
      <button type="button" className="db-ai-peer-banner-open" onClick={() => onViewPeer?.(peer.connectionId)}>{label} · 查看</button>
      <button type="button" className="db-icon-button" aria-label="关闭提示" onClick={() => onDismissPeer?.()}><X size={14} /></button>
    </div>
  }
  const active = items.find(item => !isTerminalStatus(item.status))
  if (!active) return null
  return <button className="db-info-note" onClick={() => onOpen(active.executionId)}>{executionTitle(active)} · {EXECUTION_STATUS_LABELS[active.status]} · {elapsedLabel(active)} · 打开 AI Query</button>
}

import {WorkbenchTooltips} from '../parts/overlay/tooltip.tsx'
import { allowNavigation } from '../parts/navigation-guard.ts'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleAlert, Check, Database, Info, Plus, Power, Trash2, X } from 'lucide-react'
import { WorkbenchShell } from './workbench-shell.tsx'
import { ConnectionForm } from '../connection/connection-form.tsx'
import { connectionBridge } from '../../connection-bridge.ts'
import { mergeWorkspaceConnections, mergeSessionConnections, blendLiveConnection } from '../../schema/refresh.ts'
import { coerceVisibleSchemas, unavailableBridge, type Connection, type ConnectionWorkbench } from '../../../shared/workbench.ts'
import { canReuseSavedLogin } from '../../../shared/connection-input.ts'
import { databaseCss } from '../../style-css.ts'
import { useWorkbenchTheme } from '../parts/theme/use-workbench-theme.ts'
import {DialogFrame} from '../parts/overlay/dialog-frame.tsx'

function ensureStyle(): void {
  if (typeof document === 'undefined') return
  let style = document.querySelector('style[data-database-workspace]') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.dataset.databaseWorkspace = 'true'
    document.head.appendChild(style)
  }
  style.textContent = databaseCss
}

type ToastKind = 'error' | 'ok' | 'info'
type WorkspaceToast = { text: string; kind: ToastKind }

type Props = {
  conversationId: string
  visible?: boolean
  preview?: boolean
  onActive?(connectionId?: string): void
  onDialogChange?(open: boolean): void
}

function ConfirmDialog({
  label, title, body, closeLabel, confirmLabel, confirmIcon, busy, onCancel, onConfirm,
}: {
  label: string
  title: string
  body: string
  closeLabel: string
  confirmLabel: string
  confirmIcon: React.ReactNode
  busy: boolean
  onCancel(): void
  onConfirm(): void
}): React.ReactElement {
  return <DialogFrame title={title} ariaLabel={label} closeLabel={closeLabel} size="confirm" close={onCancel} busy={busy} footer={<><button className="db-btn" disabled={busy} onClick={onCancel}>取消</button><button className="db-danger-button" disabled={busy} onClick={onConfirm}>{confirmIcon}{confirmLabel}</button></>}><p>{body}</p></DialogFrame>
}

export function DatabaseWorkspace({ conversationId, visible = true, preview = false, onActive, onDialogChange }: Props): React.ReactElement {
  ensureStyle()
  const [connections, setConnections] = useState<Connection[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [form, setForm] = useState<{ editing?: Connection }>()
  const [deleteTarget, setDeleteTarget] = useState<Connection>()
  const [disconnectTarget, setDisconnectTarget] = useState<Connection>()
  const revisionRef = useRef(0)
  const [busy, setBusy] = useState<Set<string>>(() => new Set())
  const busyRef = useRef(new Set<string>())
  const beginBusy = (id: string) => { if (busyRef.current.has(id)) return false; busyRef.current.add(id); setBusy(new Set(busyRef.current)); return true }
  const endBusy = (id: string) => { busyRef.current.delete(id); if (alive.current) setBusy(new Set(busyRef.current)) }
  const activeRef = useRef(activeId); activeRef.current = activeId
  const hasOperations = connections.some(row => row.lifecycle?.status === 'queued' || row.lifecycle?.status === 'running')
  const pollInflight = useRef(false)
  const [toast, setToast] = useState<WorkspaceToast>()
  const theme = useWorkbenchTheme()
  const dark = theme.dark
  const [passwordStorage, setPasswordStorage] = useState(() => typeof navigator !== 'undefined' && /Win/i.test(navigator.userAgent))
  const alive = useRef(true)
  const seeded = useRef(false)
  const [sqlOwner, setSqlOwner] = useState(conversationId)
  const bridge = useMemo(() => connectionBridge(sqlOwner, unavailableBridge, preview), [sqlOwner, preview])
  const showToast = useCallback((text: string, kind: ToastKind) => {
    if (!text.trim()) { setToast(undefined); return }
    setToast({ text, kind })
  }, [])
  const rememberActive = useCallback((id?: string) => {
    setActiveId(id)
    void bridge.activate?.(id).catch(error => {
      showToast(error instanceof Error ? error.message : '无法保存当前连接。', 'error')
    })
  }, [bridge, showToast])
  useEffect(() => () => { alive.current = false }, [])
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(undefined), 5000)
    return () => window.clearTimeout(timer)
  }, [toast])
  const applySnapshot = useCallback((snapshot: { connections?: Connection[]; passwordStorage?: boolean; lastActiveId?: string; revision?: number }, mode: 'full' | 'merge' | 'session') => {
    if (typeof snapshot.revision === 'number' && snapshot.revision < revisionRef.current) return
    const listed = Array.isArray(snapshot.connections) ? snapshot.connections : []
    setPasswordStorage(snapshot.passwordStorage !== false)
    if (typeof snapshot.revision === 'number') revisionRef.current = snapshot.revision
    setConnections(previous => {
      if (!previous.length || mode === 'full') return listed
      if (mode === 'session') return mergeSessionConnections(previous, listed)
      return mergeWorkspaceConnections(previous, listed)
    })
    setActiveId(previous => {
      const aliveId = previous && listed.some(row => row.id === previous)
      if (mode === 'merge' && aliveId) return previous
      if (snapshot.lastActiveId && listed.some(row => row.id === snapshot.lastActiveId)) return snapshot.lastActiveId
      return mode === 'session' ? listed[0]?.id : aliveId ? previous : listed[0]?.id
    })
    seeded.current = true
  }, [])
  useEffect(() => {
    if (!visible || seeded.current) return
    let current = true
    const load = async () => {
      if (!bridge.listWorkspace) return
      let last: unknown
      for (let attempt = 0; attempt < 8 && current; attempt++) {
        try {
          const snapshot = await bridge.listWorkspace()
          if (!current) return
          applySnapshot(snapshot, 'full')
          return
        } catch (error) {
          last = error
          await new Promise(resolve => setTimeout(resolve, 250))
        }
      }
      if (current) showToast(last instanceof Error ? last.message : '无法读取保存的数据库连接。', 'error')
    }
    void load()
    return () => { current = false }
  }, [applySnapshot, bridge, showToast, visible])
  useEffect(() => {
    if (!visible || conversationId === sqlOwner) return
    let current = true
    const next = connectionBridge(conversationId, unavailableBridge, preview)
    void (async () => {
      try {
        if (!await allowNavigation(sqlOwner) || !current) return
        const snapshot = await next.listWorkspace?.()
        if (!current || !snapshot) return
        applySnapshot(snapshot, 'session')
        setSqlOwner(conversationId)
      } catch { /* 左侧树保持当前名单，下次再拉 SQL */ }
    })()
    return () => { current = false }
  }, [applySnapshot, conversationId, preview, sqlOwner, visible])
  useEffect(() => {
    if (!visible || !bridge.listWorkspace) return
    let current = true
    const poll = async () => {
      if (document.hidden || pollInflight.current) return
      pollInflight.current = true
      try {
        const snapshot = await bridge.listWorkspace!()
        if (!current) return
        if (typeof snapshot.revision === 'number' && snapshot.revision === revisionRef.current) return
        applySnapshot(snapshot, 'merge')
      } catch { /* keep current UI; next poll retries */ }
      finally { pollInflight.current = false }
    }
    const timer = window.setInterval(() => { void poll() }, hasOperations ? 1000 : 4000)
    const onVisible = () => { if (!document.hidden) void poll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { current = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [applySnapshot, bridge, visible, hasOperations])
  useEffect(() => { onDialogChange?.(!!form || !!deleteTarget || !!disconnectTarget) }, [form, deleteTarget, disconnectTarget, onDialogChange])
  useEffect(() => { onActive?.(visible ? activeId : undefined) }, [activeId, visible, onActive])

  const active = connections.find(row => row.id === activeId)
  const reload = async () => {
    const snapshot = await bridge.listWorkspace?.()
    if (alive.current && snapshot) applySnapshot(snapshot, 'merge')
  }
  const open = async (connection: Connection) => {
    if (connection.lifecycle?.status === 'queued' || connection.lifecycle?.status === 'running' || busyRef.current.has(connection.id)) return
    if (!connection.live || connection.health === 'degraded') {
      if (canReuseSavedLogin(connection) && connection.settings && bridge.startConnection) {
        if (!beginBusy(connection.id)) return
        try {
          await bridge.startConnection({ ...connection.settings, password: '', useSavedPassword: true, rememberPassword: true }, crypto.randomUUID(), connection.id)
          await reload()
        } catch (error) { if (alive.current) showToast(error instanceof Error ? error.message : '无法连接。', 'error') }
        finally { endBusy(connection.id) }
        return
      }
      setForm({ editing: connection }); return
    }
    if (await allowNavigation(sqlOwner)) rememberActive(connection.id)
  }
  const cancel = async (id: string) => {
    const operation = connections.find(row => row.id === id)?.lifecycle
    if (!operation || !bridge.cancelConnection || !beginBusy(id)) return
    try { await bridge.cancelConnection(id, operation.operationId); await reload() }
    catch (error) { if (alive.current) showToast(error instanceof Error ? error.message : '无法取消连接。', 'error') }
    finally { endBusy(id) }
  }
  const disconnectShared = async () => {
    if (!disconnectTarget || busyRef.current.has(disconnectTarget.id) || disconnectTarget.id === activeRef.current && !await allowNavigation(sqlOwner) || !beginBusy(disconnectTarget.id)) return
    const target = disconnectTarget
    setToast(undefined); setToast(undefined)
    try {
      await bridge.disconnectConnection?.(disconnectTarget.id)
      if (!alive.current) return
          setConnections(rows => rows.map(row => row.id === disconnectTarget.id ? { ...row, live: false, health: 'offline', generation: undefined } : row))
      setDisconnectTarget(undefined)
      showToast(`已断开共享登录 ${disconnectTarget.name}，所有对话都需要重新登录后才能查询。`, 'ok')
    } catch (error) { if (alive.current) showToast(error instanceof Error ? error.message : '无法断开连接。', 'error') }
    finally { endBusy(target.id) }
  }
  const remove = async () => {
    if (!deleteTarget || busyRef.current.has(deleteTarget.id) || deleteTarget.id === activeRef.current && !await allowNavigation(sqlOwner) || !beginBusy(deleteTarget.id)) return
    const target = deleteTarget
    setToast(undefined); setToast(undefined)
    try {
      await bridge.removeConnection?.(deleteTarget.id)
      if (!alive.current) return
      setConnections(rows => rows.filter(row => row.id !== target.id))
      setDeleteTarget(undefined)
      if (activeRef.current === target.id) rememberActive(connections.find(row => row.id !== target.id)?.id)
    } catch (error) { if (alive.current) showToast(error instanceof Error ? error.message : '无法删除连接。', 'error') }
    finally { endBusy(target.id) }
  }
  const copy = async (id: string) => {
    if (!bridge.duplicateConnection || !beginBusy(id)) return
    const source = connections.find(row => row.id === id)
    if (!source) { endBusy(id); return }
    setToast(undefined)
    try {
      const connection = await bridge.duplicateConnection(id)
      if (!alive.current) return
      setConnections(rows => rows.some(row => row.id === connection.id) ? rows : [...rows, connection])
      showToast(
        source.hasPassword && !connection.hasPassword
          ? `已复制为 ${connection.name}，请重新输入密码`
          : `已复制为 ${connection.name}`,
        source.hasPassword && !connection.hasPassword ? 'info' : 'ok',
      )
    } catch (error) { if (alive.current) showToast(error instanceof Error ? error.message : '无法复制连接。', 'error') }
    finally { endBusy(id) }
  }
  const connected = async (connection: Connection) => {
    setConnections(rows => rows.some(row => row.id === connection.id) ? rows.map(row => row.id === connection.id ? blendLiveConnection(row, connection) : row) : [...rows, connection])
    setForm(undefined)
    if (connection.passwordWarning) showToast(connection.passwordWarning, 'info')
    else showToast(`已连接 ${connection.name} · ${connection.version}`, 'ok')
  }
  const patchWorkbench = useCallback((id: string, patch: ConnectionWorkbench) => {
    const next: ConnectionWorkbench = { ...patch }
    if (patch.visibleSchemas !== undefined) next.visibleSchemas = coerceVisibleSchemas(patch.visibleSchemas)
    setConnections(rows => rows.map(row => {
      if (row.id !== id) return row
      const workbench = { ...row.workbench, ...next }
      return { ...row, workbench }
    }))
    void bridge.saveWorkbench?.(id, next).catch(error => {
      showToast(error instanceof Error ? error.message : '无法保存工作台设置。', 'error')
    })
  }, [bridge, showToast])
  const pick = async (id: string) => {
    const connection = connections.find(row => row.id === id)
    if (!connection) return false
    if (id !== activeId && !await allowNavigation(sqlOwner)) return false
    rememberActive(connection.id)
    return true
  }
  const toastIcon = toast?.kind === 'error' ? <CircleAlert size={16} /> : toast?.kind === 'ok' ? <Check size={15} /> : <Info size={15} />
  const reportUnavailable = (text: string, connectionId?: string) => {
    showToast(text, 'error')
    if (connectionId) void reload()
  }

  return <div className={`db-workbench ${dark ? 'db-dark' : ''}`} {...theme.attributes} data-conversation={sqlOwner} style={{ ...theme.style, height: '100%', containerType: 'inline-size' }}>
    <WorkbenchTooltips/>
    {toast && <div
      className={`db-toast db-workspace-toast db-toast-${toast.kind}`}
      role={toast.kind === 'error' ? 'alert' : 'status'}
    >
      {toastIcon}
      <span>{toast.text}</span>
      <button type="button" className="db-toast-close db-icon-button" aria-label="关闭提示" onClick={() => setToast(undefined)}><X size={14} /></button>
    </div>}
    {connections.length ? <WorkbenchShell bridge={bridge} conversationId={sqlOwner} connection={active || connections[0]} connections={connections} busyConnections={busy} onPick={pick} onAdd={() => setForm({})} onEdit={id => {
      const target = connections.find(row => row.id === id) || active || connections[0]
      if (target) setForm({ editing: target })
    }} onCopy={id => { void copy(id) }} onConnect={id => {
      const target = connections.find(row => row.id === id)
      if (target) void open(target)
    }} onCancelConnect={id => { void cancel(id) }} onDisconnect={id => {
      const target = connections.find(row => row.id === id)
      if (target && (target.live || target.desiredState === 'online')) setDisconnectTarget(target)
    }} onDelete={id => {
      const target = connections.find(row => row.id === id)
      if (target) setDeleteTarget(target)
    }} onUnavailable={(text, connectionId) => reportUnavailable(text, connectionId)} onWorkbench={(id, patch) => patchWorkbench(id, patch)} />
      : <div className="db-result-empty"><span className="db-result-empty-icon"><Database size={24} /></span><strong>选择或添加数据库连接</strong><p>连接登录在工作区共享。复杂结构变更请使用 Navicat。</p><button className="db-primary" onClick={() => setForm({})}><Plus size={15} />添加连接</button></div>}
    {form && <ConnectionForm bridge={bridge} editing={form.editing} passwordStorage={passwordStorage} onClose={() => setForm(undefined)} onConnected={connected} onStarted={() => { void reload().catch(error => showToast(error instanceof Error ? error.message : '无法读取连接状态。', 'error')) }} />}
    {disconnectTarget && <ConfirmDialog
      label="断开共享连接"
      title={`断开“${disconnectTarget.name}”的共享登录？`}
      body="这会关闭工作区里所有对话正在使用的这次登录。"
      closeLabel="取消断开"
      confirmLabel="断开共享连接"
      confirmIcon={<Power size={14} />}
      busy={busy.has(disconnectTarget.id)}
      onCancel={() => setDisconnectTarget(undefined)}
      onConfirm={() => void disconnectShared()}
    />}
    {deleteTarget && <ConfirmDialog
      label="删除数据库连接"
      title={`删除“${deleteTarget.name}”？`}
      body="只删除保存的连接配置。"
      closeLabel="取消删除"
      confirmLabel="删除连接"
      confirmIcon={<Trash2 size={14} />}
      busy={busy.has(deleteTarget.id)}
      onCancel={() => setDeleteTarget(undefined)}
      onConfirm={() => void remove()}
    />}
  </div>
}

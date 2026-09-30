import React, { useEffect, useRef, useState } from 'react'
import { Database, X } from 'lucide-react'
import { normalizeEnvironment } from '../../../shared/connection-permission.ts'
import type { Connection, SourceConnectionInput, Dialect, WorkspaceBridge } from '../../../shared/workbench.ts'
import { supportedAllDataSources } from '../../../shared/data-sources/registry.ts'
import { clientModules } from '../../data-sources/registry.ts'
import type { ConnectionFormSource } from './connection-form-types.ts'
import { createConnectionFormRegistry } from './connection-form-registry.ts'
import { useBackdropDismiss, useDialog } from '../parts/dialog.ts'
import { DialectLogo } from '../shell/dialect-logo.tsx'

const connectionFormSources = createConnectionFormRegistry<Dialect, ConnectionFormSource>(
  clientModules.ids().map(id => clientModules.get(id).connection), supportedAllDataSources,
)

export function ConnectionForm({ bridge, editing, passwordStorage, onClose, onConnected }: { bridge: WorkspaceBridge; editing?: Connection; passwordStorage?: boolean; onClose(): void; onConnected(connection: Connection): void }) {
  const [step, setStep] = useState<'pick' | 'form'>(editing ? 'form' : 'pick')
  const [input, setInput] = useState<SourceConnectionInput>(() => connectionFormSources.get(editing?.dialect ?? 'mysql').createInput({ passwordStorage, editing }))
  const [busy, setBusy] = useState<'test' | 'connect'>(), [message, setMessage] = useState(''), [success, setSuccess] = useState(false)
  const [dirty, setDirty] = useState(false)
  const alive = useRef(true), pending = useRef(false)
  const dialog = useRef<HTMLFormElement>(null)
  useEffect(() => () => { alive.current = false }, [])
  const patch = (value: Partial<SourceConnectionInput>) => { setDirty(true); setInput(previous => ({ ...previous, ...value } as SourceConnectionInput)); setMessage(''); setSuccess(false) }
  const requestClose = () => {
    if (busy) return
    if (dirty && typeof window !== 'undefined' && !window.confirm('连接信息尚未保存，确定关闭？')) return
    onClose()
  }
  useDialog(dialog, requestClose)
  const backdrop = useBackdropDismiss(requestClose)
  const pickDialect = (dialect: Dialect) => {
    setInput(connectionFormSources.get(dialect).createInput({ passwordStorage }))
    setStep('form')
  }
  const payload = (): SourceConnectionInput => ({
    ...input,
    environment: normalizeEnvironment(input.environment),
    useSavedPassword: !input.password && !!editing?.hasPassword,
  } as SourceConnectionInput)
  const run = async (testOnly: boolean) => {
    if (pending.current) return
    pending.current = true; setBusy(testOnly ? 'test' : 'connect'); setMessage(''); setSuccess(false)
    try {
      if (!bridge.connect || !bridge.testConnection) throw new Error('连接服务不可用，请重新打开工作台。')
      const body = payload()
      if (testOnly) {
        const result = await bridge.testConnection(body, editing?.id)
        if (alive.current) { setSuccess(true); setMessage(`连接测试成功 · ${connectionFormSources.get(input.dialect).displayName} ${result.version} · ${result.elapsedMs} ms。${editing ? '原连接尚未修改。' : '尚未添加到连接列表。'}`) }
      } else {
        const connection = editing ? await bridge.updateConnection!(editing.id, body) : await bridge.connect(body)
        if (!alive.current) { if (editing) onConnected(connection); else await bridge.removeConnection?.(connection.id); return }
        setInput(previous => ({ ...previous, password: '' })); onConnected(connection); onClose()
      }
    } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : '连接失败，请检查连接信息。') }
    finally { pending.current = false; if (alive.current) setBusy(undefined) }
  }
  const source = connectionFormSources.get(input.dialect)
  const title = editing ? '编辑连接' : '新建连接'
  const subtitle = editing
    ? '新配置连接成功后才替换原连接。'
    : step === 'pick'
      ? '选择要连接的数据库类型。'
      : '先测试连接，或直接连接开始使用。'

  return <div className="db-overlay db-modal" onMouseDown={backdrop.onMouseDown} onClick={backdrop.onClick}><form ref={dialog} className="db-dialog db-connection-dialog" role="dialog" aria-modal="true" aria-label={editing ? '编辑数据库连接' : '新建数据库连接'} onClick={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); if (step === 'form') void run(false) }}>
    <div className="db-dialog-heading db-connection-dialog-heading"><div>
      <h2>{title}</h2>
      <p>{subtitle}</p>
    </div><button type="button" className="db-icon-button" aria-label="关闭连接窗口" onClick={requestClose}><X size={18} /></button></div>

    {step === 'pick' && !editing && <div className="db-connection-pick">
      <p className="db-muted">选择要连接的数据源。</p>
      <div className="db-connection-pick-grid">
        {connectionFormSources.ids().map(dialect => <button key={dialect} type="button" className="db-connection-pick-card" onClick={() => pickDialect(dialect)}>
          <DialectLogo dialect={dialect} />
          <strong>{connectionFormSources.get(dialect).displayName}</strong>
        </button>)}
      </div>
      <div className="db-dialog-footer"><button type="button" className="db-text-button" onClick={requestClose}>取消</button></div>
    </div>}

    {step === 'form' && <>
      {!editing && <div className="db-connection-form-nav">
        <button type="button" className="db-text-button" onClick={() => setStep('pick')}>上一步</button>
        <span className="db-muted">{source.displayName}</span>
      </div>}
      <fieldset disabled={!!busy} className="db-connection-fields">
        <div className="db-info-note">连接真实数据库。测试连接不会修改数据。勾选记住密码后，用当前 Windows 账户加密保存，仅本机当前用户可解密。{editing?.hasPassword && '已保存密码，留空则继续使用。'}</div>
        <label className="db-form-label">连接名称 · 可选<input value={input.name} maxLength={80} onChange={event => patch({ name: event.target.value })} placeholder="留空自动生成" /></label>
        {source.fields(input, patch, editing)}
        {source.showCredentials(input) && <div className="db-form-row"><label className="db-form-label">用户名{source.optionalUser && ' · 可选'}<input required={!source.optionalUser} value={input.username} maxLength={128} onChange={event => patch({ username: event.target.value })} autoComplete="off" /></label><label className="db-form-label">密码{source.optionalPassword && ' · 可选'}<input type="password" value={input.password} maxLength={4096} required={!source.optionalPassword && !editing?.hasPassword} onChange={event => patch({ password: event.target.value })} autoComplete="new-password" placeholder={editing?.hasPassword ? '留空使用已保存密码' : '输入密码'} /></label></div>}
        <label className="db-form-label">权限<select value={normalizeEnvironment(input.environment)} onChange={event => patch({ environment: event.target.value as SourceConnectionInput['environment'] })}><option value="sit">SIT · 可编辑</option><option value="uat">UAT · 人工 SQL 可写</option><option value="pvt">PVT · 人工 SQL 可写</option></select></label>
        <p className="db-muted db-connection-permission-note">{source.permissionNote}</p>
        <label className="db-remember"><input type="checkbox" checked={!!input.rememberPassword} disabled={passwordStorage === false} onChange={event => patch({ rememberPassword: event.target.checked })} />记住密码{passwordStorage === false && <small>当前环境无法加密保存密码</small>}</label>
      </fieldset>
      {message && <div className={`db-info-note ${success ? 'db-connection-success' : ''}`} role="status">{message}</div>}
      <div className="db-dialog-footer"><button type="button" className="db-text-button" onClick={requestClose}>取消</button><button type="button" className="db-text-button" disabled={!!busy} onClick={event => { if (event.currentTarget.form?.reportValidity()) void run(true) }}>{busy === 'test' ? '测试中…' : '测试连接'}</button><button className="db-primary" type="submit" disabled={!!busy}><Database size={14} />{busy === 'connect' ? (editing ? '保存中…' : '连接中…') : (editing ? '保存并重连' : '连接')}</button></div>
    </>}
  </form></div>
}

import {FormField} from '../parts/controls/form-field.tsx'
import React, { useEffect, useRef, useState } from 'react'
import { Database, X } from 'lucide-react'
import { normalizeEnvironment } from '../../../shared/connection-permission.ts'
import type { Connection, SourceConnectionInput, Dialect, WorkspaceBridge } from '../../../shared/workbench.ts'
import { supportedAllDataSources } from '../../../shared/data-sources/registry.ts'
import { clientModules } from '../../data-sources/registry.ts'
import type { ConnectionFormSource } from './connection-form-types.ts'
import { createConnectionFormRegistry } from './connection-form-registry.ts'
import {DialogFrame} from '../parts/overlay/dialog-frame.tsx'
import {useWorkbenchConfirm} from '../parts/overlay/confirm.tsx'
import { DialectLogo } from '../shell/dialect-logo.tsx'
import { ResourceError } from '../parts/feedback/resource-error.tsx'
import { ResourceHelp } from '../parts/overlay/action-menu.tsx'

const connectionFormSources = createConnectionFormRegistry<Dialect, ConnectionFormSource>(
  clientModules.ids().map(id => clientModules.get(id).connection), supportedAllDataSources,
)

export function ConnectionForm({ bridge, editing, passwordStorage, onClose, onConnected, onStarted }: { bridge: WorkspaceBridge; editing?: Connection; passwordStorage?: boolean; onClose(): void; onConnected(connection: Connection): void; onStarted?(started: import('../../../shared/connection-lifecycle.ts').ConnectionStart): void }) {
  const [step, setStep] = useState<'pick' | 'form'>(editing ? 'form' : 'pick')
  const [input, setInput] = useState<SourceConnectionInput>(() => connectionFormSources.get(editing?.dialect ?? 'mysql').createInput({ passwordStorage, editing }))
  const [busy, setBusy] = useState<'test' | 'connect'>(), [message, setMessage] = useState(''), [success, setSuccess] = useState(false)
  const [dirty, setDirty] = useState(false)
  const alive = useRef(true), pending = useRef(false)
  const testing = useRef<AbortController>()
  const operationId = useRef<string>()
  const [acceptancePending, setAcceptancePending] = useState(false)
  const {confirm,confirmation}=useWorkbenchConfirm()
  useEffect(() => () => { alive.current = false; testing.current?.abort() }, [])
  const patch = (value: Partial<SourceConnectionInput>) => { setDirty(true); setInput(previous => ({ ...previous, ...value } as SourceConnectionInput)); setMessage(''); setSuccess(false) }
  const requestClose = async () => {
    if (busy === 'connect') return
    testing.current?.abort()
    if(dirty&&!await confirm({title:'放弃连接修改',body:'连接信息尚未保存，确定关闭？',confirmLabel:'放弃修改'}))return
    if(!alive.current||pending.current)return
    onClose()
  }
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
        const result = await bridge.testConnection(body, editing?.id, (testing.current = new AbortController()).signal)
        if (alive.current) { setSuccess(true); setMessage(`连接测试成功 · ${connectionFormSources.get(input.dialect).displayName} ${result.version} · ${result.elapsedMs} ms。${editing ? '原连接尚未修改。' : '尚未添加到连接列表。'}`) }
      } else if (bridge.startConnection) {
        operationId.current ||= crypto.randomUUID()
        const started = await bridge.startConnection(body, operationId.current, editing?.id)
        operationId.current = undefined; setAcceptancePending(false)
        body.password = ''; body.caPem = ''
        if (alive.current) { setInput(previous => ({ ...previous, password: '', caPem: '' })); onStarted?.(started); onClose() }
      } else {
        const connection = editing ? await bridge.updateConnection!(editing.id, body) : await bridge.connect(body)
        if (!alive.current) return
        setInput(previous => ({ ...previous, password: '' })); onConnected(connection); onClose()
      }
    } catch (error) {
      const unknown = !!(error as {acceptanceUnknown?: boolean})?.acceptanceUnknown
      if (!unknown) operationId.current = undefined
      if (alive.current) {setAcceptancePending(unknown); setMessage(unknown ? '未能确认连接请求是否已接受；再次提交将核对同一个操作，请勿另建重复连接。' : error instanceof Error ? error.message : '连接失败，请检查连接信息。')}
    }
    finally { pending.current = false; testing.current = undefined; if (alive.current) setBusy(undefined) }
  }
  const source = connectionFormSources.get(input.dialect)
  const title = editing ? '编辑连接' : '新建连接'
  return <><DialogFrame title={title} ariaLabel={editing?'编辑数据库连接':'新建数据库连接'} close={()=>void requestClose()} closeLabel="关闭连接窗口" busy={!!busy} className="db-connection-dialog" onInvalidCapture={event=>{const details=(event.target as HTMLElement).closest('details');if(details)details.open=true}} onSubmit={event=>{event.preventDefault();if(step==='form')void run(false)}} footer={step==='pick'?<button type="button" className="db-btn" onClick={requestClose}>取消</button>:      <><button type="button" className="db-btn" onClick={requestClose}>取消</button><button type="button" className="db-btn" disabled={!!busy} onClick={event => { if (event.currentTarget.form?.reportValidity()) void run(true) }}>{busy === 'test' ? '测试中…' : '测试连接'}</button><button className="db-primary" type="submit" disabled={!!busy}><Database size={14} />{busy === 'connect' ? (editing ? '保存中…' : '连接中…') : (editing ? '保存并重连' : '连接')}</button></>}>
    {step === 'pick' && !editing && <div className="db-connection-pick">
      <div className="db-connection-pick-grid">
        {connectionFormSources.ids().map(dialect => <button key={dialect} type="button" className="db-connection-pick-card" onClick={() => pickDialect(dialect)}>
          <DialectLogo dialect={dialect} />
          <strong>{connectionFormSources.get(dialect).displayName}</strong>
        </button>)}
      </div>
    </div>}

    {step === 'form' && <>
      {!editing && <div className="db-connection-form-nav">
        <button type="button" className="db-text-button" onClick={() => setStep('pick')}>上一步</button>
        <span className="db-muted">{source.displayName}</span>
      </div>}
      <div className="db-connection-fields-scroll"><fieldset disabled={!!busy || acceptancePending} className="db-connection-fields">
        <h3 className="db-form-section-title">基本信息</h3>
        <FormField label="连接名称 · 可选"><input value={input.name} maxLength={80} onChange={event => patch({ name: event.target.value })} placeholder="留空自动生成" /></FormField>
        {source.fields(input, patch, editing)}
        {source.showCredentials(input) && <><h3 className="db-form-section-title">认证</h3><div className="db-form-row"><label className="db-form-label">用户名{source.optionalUser && ' · 可选'}<input required={!source.optionalUser} value={input.username} maxLength={128} onChange={event => patch({ username: event.target.value })} autoComplete="off" /></label><label className="db-form-label">密码{source.optionalPassword && ' · 可选'}<input type="password" value={input.password} maxLength={4096} required={!source.optionalPassword && !editing?.hasPassword} onChange={event => patch({ password: event.target.value })} autoComplete="new-password" placeholder={editing?.hasPassword ? '留空使用已保存密码' : '输入密码'} /></label></div></>}
        <label className="db-form-label">权限<select value={normalizeEnvironment(input.environment)} onChange={event => patch({ environment: event.target.value as SourceConnectionInput['environment'] })}><option value="sit">SIT · 可编辑</option><option value="uat">UAT · 人工 SQL 可写</option><option value="pvt">PVT · 人工 SQL 可写</option></select></label>
        <p className="db-muted db-connection-permission-note">{source.permissionNote}</p>
        <div className="db-remember-row"><label className="db-remember"><input type="checkbox" checked={!!input.rememberPassword} disabled={passwordStorage === false} onChange={event => patch({ rememberPassword: event.target.checked })} />记住密码{passwordStorage === false && <small>当前环境无法加密保存密码</small>}</label><ResourceHelp label="密码保存说明">用当前 Windows 账户加密保存，仅本机当前用户可解密。{editing?.hasPassword && '已保存密码，留空则继续使用。'}</ResourceHelp></div>
      </fieldset></div>
      {message && (success ? <p className="db-connection-success" role="status">{message}</p> : <ResourceError message={message}/>)}

    </>}
  </DialogFrame>{confirmation}</>
}

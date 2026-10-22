import {useWorkbenchConfirm} from '../workspace/parts/overlay/confirm.tsx'
import React, { useEffect, useState } from 'react'
import { Check, Copy, RefreshCw, Trash2 } from 'lucide-react'
import { ActionMenu } from '../workspace/parts/overlay/action-menu.tsx'
import { typeLabel } from './key-model.ts'
import { displayBytes } from '../../shared/redis-bytes.ts'

export function RedisKeyToolbar({
  name, keyType, ttl, operable, scopeIdentity, canRefresh, onRename, onExpire, onPersist, onDelete, onRefresh, onCopy, onTtlError,
}: {
  name: string
  scopeIdentity?:string
  keyType: string
  ttl?: number
  operable: boolean
  canRefresh: boolean
  onRename(next: string): Promise<boolean>
  onExpire(seconds: number): void
  onPersist(): void
  onDelete(): void
  onRefresh(): void
  onCopy(): void
  onTtlError(message: string): void
}): React.ReactElement {
  const {confirm,confirmation}=useWorkbenchConfirm()
  const target=React.useRef({name,operable,scopeIdentity});target.current={name,operable,scopeIdentity}
  const label = displayBytes(name)
  const [nextName, setNextName] = useState(label)
  const [seconds, setSeconds] = useState('')
  const [editing, setEditing] = useState<'name' | 'ttl'>()
  useEffect(() => { setNextName(label); setSeconds(''); setEditing(undefined) }, [label])
  const commitName = () => {
    // 输入框展示的是转义串；比较用展示串，解析交给上层 edit 统一做一次。
    const trimmed = nextName.trim()
    if (!operable || !trimmed || trimmed === label) { setNextName(label); return }
    void onRename(trimmed).then(ok => { if (!ok) setNextName(label); else setEditing(undefined) })
  }
  const applyTtl = () => {
    const value = Number(seconds)
    if (!Number.isInteger(value) || value < 1) { onTtlError('TTL 秒数无效。'); return }
    onExpire(value)
    setSeconds('')
  }
  const ttlLabel = ttl === -1 ? '永久' : ttl === -2 ? '不存在' : ttl === undefined ? 'TTL 未知' : `剩余 ${ttl}s`
  return <>
    {confirmation}
    <div className="db-redis-key-toolbar">
      <strong className="db-redis-key-title" title={label} tabIndex={0}>{label}</strong>
      <span className="db-redis-key-type">{keyType ? typeLabel(keyType) : '…'}</span>
      <span className="db-resource-summary" title={`TTL ${ttl ?? '未知'}`} tabIndex={0}>{ttlLabel}</span>
      <div className="db-resource-actions">
        <button className="db-icon-button" type="button" title="刷新 Key" aria-label="刷新 Key" disabled={!canRefresh} onClick={onRefresh}><RefreshCw size={14} /></button>
        <button className="db-icon-button" type="button" title="复制 Key" aria-label="复制 Key" onClick={onCopy}><Copy size={14} /></button>
        <ActionMenu label="更多 Key 操作">
          <button role="menuitem" disabled={!operable} onClick={() => setEditing('ttl')}>修改 TTL</button>
          <button role="menuitem" disabled={!operable} onClick={() => setEditing('name')}>重命名</button>
          <button role="menuitem" className="db-stop" disabled={!operable} onClick={async()=>{if(!await confirm({title:'删除 Key',body:`删除 Key ${label}？`,confirmLabel:'删除 Key',danger:true}))return;if(target.current.name===name&&target.current.operable&&target.current.scopeIdentity===scopeIdentity)onDelete()}}><Trash2 size={14}/>删除</button>
        </ActionMenu>
      </div>
    </div>
    {editing && <form className="db-redis-key-edit-panel" onSubmit={event => { event.preventDefault(); if (editing === 'name') commitName(); else applyTtl() }}>
      {editing === 'name' ? <label className="db-resource-inline-field">Key 名<input autoFocus aria-label="Key 名" value={nextName} disabled={!operable} onChange={event => setNextName(event.target.value)}/></label>
        : <><label className="db-resource-inline-field">TTL 秒数<input autoFocus aria-label="TTL 秒数" type="number" min={1} value={seconds} disabled={!operable} placeholder="秒" onChange={event => setSeconds(event.target.value)}/></label><button className="db-btn" type="button" disabled={!operable || ttl === -1} onClick={onPersist}>设为永久</button></>}
      <button className="db-btn" type="submit" disabled={!operable} aria-label={editing === 'name' ? '确认重命名' : '设置 TTL'}><Check size={14}/>应用</button>
      <button className="db-text-button" type="button" onClick={() => setEditing(undefined)}>取消</button>
    </form>}
  </>
}

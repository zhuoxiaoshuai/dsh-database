import React, { useEffect, useState } from 'react'
import { Check, Copy, RefreshCw, Trash2 } from 'lucide-react'
import { typeLabel } from './key-model.ts'

export function RedisKeyToolbar({
  name, keyType, ttl, operable, canRefresh, onRename, onExpire, onPersist, onDelete, onRefresh, onCopy, onTtlError,
}: {
  name: string
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
  const [nextName, setNextName] = useState(name)
  const [seconds, setSeconds] = useState('')
  useEffect(() => { setNextName(name) }, [name])
  const commitName = () => {
    const trimmed = nextName.trim()
    if (!operable || !trimmed || trimmed === name) { setNextName(name); return }
    void onRename(trimmed).then(ok => { if (!ok) setNextName(name) })
  }
  const applyTtl = () => {
    const value = Number(seconds)
    if (!Number.isInteger(value) || value < 1) { onTtlError('TTL 秒数无效。'); return }
    onExpire(value)
    setSeconds('')
  }
  return <div className="db-redis-key-toolbar">
    <span className="db-redis-key-type">{keyType ? typeLabel(keyType) : '…'}</span>
    <input className="db-redis-key-name" aria-label="Key 名" value={nextName} disabled={!operable}
      onChange={event => setNextName(event.target.value)}
      onBlur={commitName}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitName() } }} />
    {ttl !== undefined && <span className="db-muted">TTL {ttl}</span>}
    <input aria-label="TTL 秒数" type="number" min={1} value={seconds} disabled={!operable} placeholder="秒" onChange={event => setSeconds(event.target.value)} />
    <button className="db-redis-btn" type="button" aria-label="设置 TTL" disabled={!operable} onMouseDown={event => event.preventDefault()} onClick={applyTtl}><Check size={13} /></button>
    <label className="db-redis-key-persist"><input type="checkbox" checked={ttl === -1} disabled={!operable || ttl === -1} onChange={() => onPersist()} />持久</label>
    <button className="db-redis-btn db-solid-danger" type="button" disabled={!operable} onClick={() => { if (typeof window !== 'undefined' && !window.confirm(`删除 Key ${name}？`)) return; onDelete() }}><Trash2 size={13} />删除</button>
    <button className="db-redis-btn db-ok" type="button" aria-label="刷新 Key" disabled={!canRefresh} onClick={onRefresh}><RefreshCw size={13} /></button>
    <button className="db-redis-btn" type="button" aria-label="复制 Key" onClick={onCopy}><Copy size={13} /></button>
  </div>
}

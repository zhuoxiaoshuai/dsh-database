import React, { useRef, useState } from 'react'
import {DialogFrame} from './workspace/parts/overlay/dialog-frame.tsx'
import {ResourceError} from './workspace/parts/feedback/resource-error.tsx'

export function SaveExperienceDialog({
  open, defaultName, busy, error, success, onCancel, onConfirm,
}: {
  open: boolean
  defaultName?: string
  busy?: boolean
  error?: string
  success?: string
  onCancel(): void
  onConfirm(name: string): void
}): React.ReactElement | null {
  const [name, setName] = useState(defaultName || '')
  if (!open) return null
  return <DialogFrame title="保存到经验库" close={onCancel} busy={busy} footer={<><button type="button" className="db-btn" disabled={busy} onClick={onCancel}>{success ? '关闭' : '取消'}</button><button type="button" className="db-primary" disabled={busy || !name.trim() || !!success} onClick={() => onConfirm(name.trim())}>保存</button></>}>
    {error && <ResourceError message={error}/>}
    {success && !error && <p className="db-info-note" role="status">{success}</p>}
    <label className="db-form-label">名称<input value={name} onChange={e => setName(e.target.value)} placeholder="例如：查询 hosts" autoFocus /></label>
    <p className="db-muted">简介和标签会自动识别；完全相同的 SQL 会合并到已有经验。</p>
  </DialogFrame>
}

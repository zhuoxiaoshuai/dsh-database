import React, { useRef, useState } from 'react'
import { useDialog } from './workspace/parts/dialog.ts'

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
  const dialog = useRef<HTMLDivElement>(null)
  useDialog(dialog, onCancel, open && !busy)
  if (!open) return null
  return <div className="db-overlay db-modal"><div ref={dialog} className="db-dialog" role="dialog" aria-modal="true" aria-label="保存到经验库">
    <div className="db-dialog-heading"><h2>保存到经验库</h2><p>简介和标签会自动识别；完全相同的 SQL 会合并到已有经验。</p></div>
    {error && <p className="db-error" role="alert">{error}</p>}
    {success && !error && <p className="db-info-note" role="status">{success}</p>}
    <label className="db-form-label">名称<input value={name} onChange={e => setName(e.target.value)} placeholder="例如：查询 hosts" autoFocus /></label>
    <div className="db-dialog-footer">
      <button type="button" disabled={busy} onClick={onCancel}>{success ? '关闭' : '取消'}</button>
      <button type="button" className="db-primary" disabled={busy || !name.trim() || !!success} onClick={() => onConfirm(name.trim())}>保存</button>
    </div>
  </div></div>
}

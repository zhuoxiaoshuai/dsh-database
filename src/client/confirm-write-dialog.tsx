import React, { useRef } from 'react'
import { useDialog } from './workspace/parts/dialog.ts'

export function ConfirmWriteDialog({
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  busy?: boolean
  error?: string
  onCancel(): void
  onConfirm(): void
}): React.ReactElement {
  const dialog = useRef<HTMLDivElement>(null)
  useDialog(dialog, onCancel, !busy)
  return <div className="db-overlay db-modal">
    <div ref={dialog} className="db-dialog" role="dialog" aria-modal="true" aria-label="确认提交">
      <div className="db-dialog-heading"><h2>确认提交？</h2></div>
      {error && <p className="db-error" role="alert">{error}</p>}
      <div className="db-dialog-footer">
        <button type="button" disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" className="db-primary" disabled={busy} onClick={onConfirm}>{busy ? '正在提交…' : '确认'}</button>
      </div>
    </div>
  </div>
}

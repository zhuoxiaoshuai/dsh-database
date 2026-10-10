import React from 'react'
import {DialogFrame} from './workspace/parts/dialog-frame.tsx'

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
  return <DialogFrame title="确认提交" close={onCancel} busy={busy} footer={<><button type="button" disabled={busy} onClick={onCancel}>取消</button><button type="button" className="db-primary" disabled={busy} onClick={onConfirm}>{busy ? '正在提交…' : '确认'}</button></>}>{error && <p className="db-error" role="alert">{error}</p>}</DialogFrame>
}

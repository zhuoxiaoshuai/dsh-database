import {ResourceError} from './workspace/parts/feedback/resource-error.tsx'
import React from 'react'
import {DialogFrame} from './workspace/parts/overlay/dialog-frame.tsx'

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
  return <DialogFrame title="确认提交" size="confirm" close={onCancel} busy={busy} footer={<><button type="button" className="db-btn" disabled={busy} onClick={onCancel}>取消</button><button type="button" className="db-primary" disabled={busy} onClick={onConfirm}>{busy ? '正在提交…' : '提交修改'}</button></>}>{error && <ResourceError message={error}/>}</DialogFrame>
}

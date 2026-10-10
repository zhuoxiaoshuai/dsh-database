import React, {useRef} from 'react'
import {useDialog, useBackdropDismiss} from './dialog.ts'
export function DialogFrame({title, close, busy = false, children, footer}: {title: string; close(): void; busy?: boolean; children: React.ReactNode; footer?: React.ReactNode}) {
  const ref = useRef<HTMLDivElement>(null)
  const dismiss = () => {if (!busy) close()}
  useDialog(ref,dismiss); const backdrop = useBackdropDismiss(dismiss)
  return <div className="db-overlay db-modal" {...backdrop}><div ref={ref} className="db-dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
    <header className="db-dialog-heading"><strong>{title}</strong><button type="button" disabled={busy} onClick={dismiss} aria-label="关闭">×</button></header>
    {children}{footer && <footer className="db-dialog-footer">{footer}</footer>}
  </div></div>
}

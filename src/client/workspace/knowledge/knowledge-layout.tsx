import React, { useState } from 'react'
import { X } from 'lucide-react'
import { useDragResize } from '../parts/use-drag-resize.ts'

/** Shared list/editor shell for source-specific knowledge analyzers and result renderers. */
export function KnowledgeLayout({ label, embedded = true, error, listHeader, listBody, children, onClose, className = '' }: {
  label: string
  embedded?: boolean
  error?: string
  listHeader: React.ReactNode
  listBody: React.ReactNode
  children: React.ReactNode
  onClose?(): void
  className?: string
}): React.ReactElement {
  const [listWidth, setListWidth] = useState(240)
  const startResize = useDragResize((start, next) => setListWidth(Math.min(360, Math.max(180, listWidth + next.clientX - start.clientX))))
  const shell = <section className={`${embedded ? 'db-template-library db-template-library-embedded' : 'db-dialog db-template-library'} ${className}`} role={embedded ? undefined : 'dialog'} aria-modal={embedded ? undefined : true} aria-label={label}>
    {error && <div className="db-error" role="alert">{error}</div>}
    <div className="db-template-workspace db-template-workspace-split">
      <div className="db-template-list-pane" style={{ width: listWidth }}>
        <div className="db-template-list-head">{listHeader}</div>
        <div className="db-template-list">{listBody}</div>
        <div className="db-template-list-resizer" role="separator" aria-label="调整列表宽度" onPointerDown={startResize} />
      </div>
      <div className="db-template-run">{children}</div>
    </div>
    {!embedded && onClose && <button type="button" className="db-icon-button db-template-dialog-close" aria-label="关闭经验库" onClick={onClose}><X size={18} /></button>}
  </section>
  return embedded ? shell : <div className="db-overlay">{shell}</div>
}

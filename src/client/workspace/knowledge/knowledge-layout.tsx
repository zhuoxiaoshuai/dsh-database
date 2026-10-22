import {DrawerBackdrop,DrawerClose} from '../parts/layout/drawer-chrome.tsx'
import {DialogFrame} from '../parts/overlay/dialog-frame.tsx'
import React, { useRef, useState } from 'react'
import { List, X } from 'lucide-react'
import { useDragResize } from '../parts/hooks/use-drag-resize.ts'
import { usePanelSize } from '../parts/hooks/use-panel-size.ts'
import { useDrawerFocus } from '../parts/overlay/use-drawer-focus.ts'
import { ResourceError } from '../parts/feedback/resource-error.tsx'

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
  const root = useRef<HTMLElement>(null), panel = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const {width}=usePanelSize(root)
  const compact=width>0 && width<760
  const [open,setOpen]=useState(false)
  useDrawerFocus(compact && open,panel,trigger,()=>setOpen(false))
  const [listWidth, setListWidth] = useState(220)
  const startResize = useDragResize((start, next) => setListWidth(Math.min(320, Math.max(180, listWidth + next.clientX - start.clientX))))
  const shell = <section ref={root} className={`db-template-library db-template-library-embedded ${className}${compact?' is-knowledge-compact':''}${open?' is-list-open':''}`} aria-label={label}>
    {error && <ResourceError message={error}/>}
    {compact && <button ref={trigger} type="button" className="db-text-button db-knowledge-trigger" aria-label="打开经验列表" aria-expanded={open} onClick={()=>setOpen(value=>!value)}><List size={14}/>经验列表</button>}
    {compact && open && <DrawerBackdrop label="关闭经验列表" close={()=>setOpen(false)}/>}
    <div className="db-template-workspace db-template-workspace-split">
      <div ref={panel} tabIndex={-1} className="db-template-list-pane" style={{ width: compact?280:listWidth }} aria-hidden={compact && !open ? true : undefined}>
        {compact && <DrawerClose label="关闭经验列表" close={()=>setOpen(false)}/>}
        <div className="db-template-list-head">{listHeader}</div>
        <div className="db-template-list" onClick={event=>{if ((event.target as HTMLElement).closest('.db-template-list-main')) setOpen(false)}}>{listBody}</div>
        <div className="db-template-list-resizer" role="separator" aria-label="调整列表宽度" onPointerDown={startResize} />
      </div>
      <div className="db-template-run">{children}</div>
    </div>
  </section>
  return embedded?shell:<DialogFrame title={label} close={onClose??(()=>{})} size="wide">{shell}</DialogFrame>
}

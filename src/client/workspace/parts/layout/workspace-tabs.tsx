import React, { useRef } from 'react'
import { Plus, List, X } from 'lucide-react'
import { ActionMenu } from '../overlay/action-menu.tsx'

export type WorkspaceTab = { id: string; label: React.ReactNode; title?: string; closable?: boolean; dirty?: boolean }
export type WorkspaceTaskAction = { id: string; label: string; disabled?: boolean; onOpen(): void }

export function WorkspaceTabs({ tabs, active, onActivate, onClose, actions = [], label = '工作区页签' }: {
  tabs: readonly WorkspaceTab[]
  active: string
  onActivate(id: string): void
  onClose?(id: string): void
  label?: string
  actions?: readonly WorkspaceTaskAction[]
}): React.ReactElement {
  const root = useRef<HTMLDivElement>(null)
  const close = (tab: WorkspaceTab) => {
    onClose?.(tab.id)
  }
  return <div className="db-task-strip"><div className="db-task-actions">
    {actions.length > 0 && <ActionMenu label="新建任务" icon={<Plus size={15}/>}><>{actions.map(action => <button key={action.id} role="menuitem" disabled={action.disabled} onClick={action.onOpen}>{action.label}</button>)}</></ActionMenu>}
    <ActionMenu label="任务列表" icon={<List size={15}/>}><>{tabs.map(tab => <button key={tab.id} role="menuitem" aria-current={tab.id === active ? 'page' : undefined} onClick={() => onActivate(tab.id)}>{tab.label}</button>)}</></ActionMenu>
  </div><div ref={root} className="db-query-tabs" role="tablist" aria-label={label} onKeyDown={event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key) || !(event.target as Element).matches('[role=tab]')) return
    const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role=tab]') || [])
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
    event.preventDefault(); buttons[next]?.focus(); onActivate(tabs[next].id)
  }}>
    {tabs.map(tab => <div key={tab.id} className={`db-query-tab ${active === tab.id ? 'is-active' : ''}`}>
      <button type="button" role="tab" tabIndex={active === tab.id ? 0 : -1} aria-selected={active === tab.id} aria-description={tab.dirty ? '未保存' : undefined} title={tab.title || (typeof tab.label === 'string' ? tab.label : undefined)} onClick={() => onActivate(tab.id)}><span className="db-task-label">{tab.label}</span>{tab.dirty && <span className="db-unsaved-dot" aria-hidden="true" title="未保存" />}</button>
      {tab.closable && <button type="button" className="db-icon-button" aria-label="关闭页签" title={`关闭 ${tab.title || (typeof tab.label === 'string' ? tab.label : '页签')}`} onClick={() => close(tab)}><X size={12} /></button>}
    </div>)}
  </div></div>
}

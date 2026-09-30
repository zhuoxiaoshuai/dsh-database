import React, { useState } from 'react'
import { X } from 'lucide-react'

export type WorkspaceTab = { id: string; label: React.ReactNode; title?: string; closable?: boolean; dirty?: boolean }

/** Shared tab identity, activation and close fallback; sources own tab content. */
export function useWorkspaceTabState<T>(initialTabs: () => T[], initialActive: () => string, options: {
  id(tab: T): string
  fallback: string
  onClose?(tab: T): void
}) {
  const [tabs, setTabs] = useState<T[]>(initialTabs)
  const [active, setActive] = useState(initialActive)
  const open = (tab: T) => {
    const id = options.id(tab)
    setTabs(previous => previous.some(item => options.id(item) === id) ? previous : [...previous, tab])
    setActive(id)
  }
  const close = (id: string) => {
    if (id === options.fallback) return
    setTabs(previous => {
      const closing = previous.find(tab => options.id(tab) === id)
      if (closing) options.onClose?.(closing)
      const next = previous.filter(tab => options.id(tab) !== id)
      setActive(current => current === id ? (next.at(-1) ? options.id(next.at(-1)!) : options.fallback) : current)
      return next
    })
  }
  return { tabs, setTabs, active, setActive, open, close }
}

export function WorkspaceTabs({ tabs, active, onActivate, onClose, label = '工作区页签' }: {
  tabs: readonly WorkspaceTab[]
  active: string
  onActivate(id: string): void
  onClose?(id: string): void
  label?: string
}): React.ReactElement {
  const close = (tab: WorkspaceTab) => {
    if (tab.dirty && typeof window !== 'undefined' && !window.confirm('此页签有未保存的更改，确定关闭？')) return
    onClose?.(tab.id)
  }
  return <div className="db-query-tabs" role="tablist" aria-label={label}>
    {tabs.map(tab => <div key={tab.id} className={`db-query-tab ${active === tab.id ? 'is-active' : ''}`}>
      <button type="button" role="tab" aria-selected={active === tab.id} title={tab.title} onClick={() => onActivate(tab.id)}>{tab.label}</button>
      {tab.closable && <button type="button" className="db-icon-button" aria-label="关闭页签" onClick={() => close(tab)}><X size={12} /></button>}
    </div>)}
  </div>
}

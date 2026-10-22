import {useFloatingSurface} from './workspace/parts/overlay/floating-surface.tsx'
import {listboxKeyDown} from './workspace/parts/controls/listbox.ts'
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { overlayMenuClass } from './workspace/parts/overlay-menu.ts'
import { useWorkbenchTheme } from './workspace/parts/theme/use-workbench-theme.ts'
import type { WorkspaceBridge } from '../shared/workbench.ts'

type TemplateItem = { id: string; title: string; summary: string; originalSql?: string }

export function SqlToolbarTemplatePicker({
  bridge,
  connectionId,
  dialect,
  reloadKey,
  onInsert,
}: {
  bridge: WorkspaceBridge
  connectionId: string
  dialect: string
  reloadKey?: number
  onInsert(sql: string): void
}) {
  const box = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const theme = useWorkbenchTheme(box.current)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<TemplateItem[]>([])
  const seq = useRef(0)

  const load = async (text: string) => {
    if (!bridge.templates) return
    const n = ++seq.current
    try {
      const result = await bridge.templates('template-search', { query: text, dialect, connectionId }) as { items?: TemplateItem[] }
      if (n !== seq.current) return
      setItems(result.items || [])
    } catch {
      if (n === seq.current) setItems([])
    }
  }

  useEffect(() => { void load('') }, [bridge, connectionId, dialect, reloadKey])
  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => { void load(query) }, 300)
    return () => window.clearTimeout(timer)
  }, [query, open, bridge, connectionId, dialect])

  const {position:pos}=useFloatingSurface({open,anchor:box,surface:menu,width:320,close:()=>{setOpen(false);setQuery('')}})

  const pick = async (item: TemplateItem) => {
    setOpen(false)
    setQuery('')
    try {
      const full = await bridge.templates!('template-get', { id: item.id, connectionId }) as TemplateItem
      const text = full.originalSql || item.originalSql || ''
      if (text) onInsert(text)
    } catch { /* ignore */ }
  }

  const list = open ? createPortal(
    <div
      ref={menu}
      className={overlayMenuClass(box.current, 'db-template-picker-menu')}
      {...theme.attributes}
      role="listbox"
      data-db-parent-dialog={box.current?.closest('[data-db-dialog-id]')?.getAttribute('data-db-dialog-id')}
      style={{...theme.style,position:'fixed',...pos,zIndex:80}}
      onKeyDown={event=>listboxKeyDown(event,menu.current,()=>setOpen(false))}
    >
      {items.slice(0, 20).map(item => (
        <button key={item.id} type="button" role="option" aria-selected={false} tabIndex={-1} className="db-template-picker-option" onClick={() => void pick(item)}>
          <strong>{item.title}</strong>
          {item.summary ? <small>{item.summary}</small> : null}
        </button>
      ))}
      {!items.length && <button type="button" className="db-muted" onClick={() => setOpen(false)}>没有匹配的经验。</button>}
    </div>,
    document.body,
  ) : null

  return <div className="db-menu-owner db-search-select db-template-toolbar-picker" ref={box}>
    <input
      className="db-search-select-input"
      aria-label="搜索经验库"
      aria-expanded={open}
      placeholder="经验库"
      value={query}
      onChange={e => { setQuery(e.target.value); setOpen(true) }}
      onFocus={() => setOpen(true)}
      onKeyDown={event=>listboxKeyDown(event,menu.current,()=>{setOpen(false);setQuery('')})}
    />
    {list}
  </div>
}

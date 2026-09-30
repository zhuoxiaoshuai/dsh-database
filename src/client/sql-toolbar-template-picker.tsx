import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { overlayMenuClass } from './workspace/parts/overlay-menu.ts'
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
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<TemplateItem[]>([])
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>()
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

  useEffect(() => {
    if (!open) return
    const place = () => {
      const rect = box.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(320, Math.max(rect.width, 200))
      setPos({ top: rect.bottom + 4, left: rect.left, width })
    }
    place()
    const close = (event: PointerEvent) => {
      const target = event.target as Node
      if (box.current?.contains(target) || menu.current?.contains(target)) return
      setOpen(false)
      setQuery('')
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); setQuery('') }
    }
    const timer = window.setTimeout(() => {
      window.addEventListener('pointerdown', close)
      window.addEventListener('keydown', onKey)
      window.addEventListener('resize', place)
      window.addEventListener('scroll', place, true)
    }, 0)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  const pick = async (item: TemplateItem) => {
    setOpen(false)
    setQuery('')
    try {
      const full = await bridge.templates!('template-get', { id: item.id, connectionId }) as TemplateItem
      const text = full.originalSql || item.originalSql || ''
      if (text) onInsert(text)
    } catch { /* ignore */ }
  }

  const list = open && pos ? createPortal(
    <div
      ref={menu}
      className={overlayMenuClass(box.current, 'db-template-picker-menu')}
      role="listbox"
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 80 }}
    >
      {items.slice(0, 20).map(item => (
        <button key={item.id} type="button" className="db-template-picker-option" onClick={() => void pick(item)}>
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
      onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.blur(); setOpen(false); setQuery('') } }}
    />
    {list}
  </div>
}

import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { overlayMenuClass } from './workspace/parts/overlay-menu.ts'

export function SearchSelect({
  value,
  options,
  onPick,
  placeholder,
  ariaLabel,
  className = '',
  emptyLabel,
  loading = false,
  onOpen,
}: {
  value: string
  options: string[]
  onPick(value: string): void
  placeholder: string
  ariaLabel: string
  className?: string
  emptyLabel?: string
  loading?: boolean
  onOpen?(): void
}) {
  const box = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(value)
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>()
  useEffect(() => { if (!open) setQuery(value) }, [value, open])
  const needle = query.trim().toLocaleLowerCase()
  const filtered = options.filter(name => !needle || name.toLocaleLowerCase().includes(needle))
  useEffect(() => {
    if (!open) return
    const place = () => {
      const rect = box.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(280, Math.max(rect.width, 180))
      setPos({ top: rect.bottom + 4, left: rect.left, width })
    }
    place()
    const close = (event: PointerEvent) => {
      const target = event.target as Node
      if (box.current?.contains(target) || menu.current?.contains(target)) return
      setOpen(false)
      setQuery(value)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        setQuery(value)
      }
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
  }, [open, value])
  const pick = (name: string) => {
    onPick(name)
    setQuery(name)
    setOpen(false)
  }
  const list = open && pos ? createPortal(
    <div
      ref={menu}
      className={overlayMenuClass(box.current)}
      role="listbox"
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 80 }}
    >
      {emptyLabel && value ? <button type="button" onClick={() => pick('')}>{emptyLabel}</button> : null}
      {filtered.slice(0, 40).map(name => <button key={name} type="button" className={name === value ? 'is-active' : ''} onClick={() => pick(name)}>{name}</button>)}
      {loading && !filtered.length && <button type="button" className="db-muted" onClick={() => setOpen(false)}>正在加载…</button>}
      {!loading && !filtered.length && !(emptyLabel && value) && <button type="button" className="db-muted" onClick={() => setOpen(false)}>没有匹配项。</button>}
    </div>,
    document.body,
  ) : null
  return <div className={`db-menu-owner db-search-select ${className}`.trim()} ref={box}>
    <input
      className="db-search-select-input"
      aria-label={ariaLabel}
      aria-expanded={open}
      placeholder={placeholder}
      value={open ? query : value}
      onChange={e => {
        const wasOpen = open
        setQuery(e.target.value)
        setOpen(true)
        if (!wasOpen) onOpen?.()
      }}
      onFocus={() => {
        const wasOpen = open
        setOpen(true)
        if (!wasOpen) onOpen?.()
        if (!wasOpen && query === value) setQuery('')
      }}
      onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.blur(); setOpen(false); setQuery(value) } }}
    />
    {list}
  </div>
}

import {useFloatingSurface} from '../overlay/floating-surface.tsx'
import {listboxKeyDown} from './listbox.ts'
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { overlayMenuClass } from '../overlay-menu.ts'
import { useWorkbenchTheme } from '../theme/use-workbench-theme.ts'

export type SearchSelectFieldProps = Pick<React.InputHTMLAttributes<HTMLInputElement>, 'id' | 'aria-describedby' | 'aria-invalid'>

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
  allowCustom = false,
  onSearch,
  onMore,
  hasMore = false,
  error,
  onRetry,
  id,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
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
  allowCustom?: boolean
  onSearch?(query: string): void
  onMore?(): void
  hasMore?: boolean
  error?: string
  onRetry?(): void
} & SearchSelectFieldProps) {
  const box = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const theme = useWorkbenchTheme(box.current)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(value)
  useEffect(() => { if (!open) setQuery(value) }, [value, open])
  const needle = query.trim().toLocaleLowerCase()
  const filtered = options.filter(name => !needle || name.toLocaleLowerCase().includes(needle))
  const {position:pos}=useFloatingSurface({open,anchor:box,surface:menu,width:280,close:()=>{setOpen(false);setQuery(value)}})

  const pick = (name: string) => {
    onPick(name)
    setQuery(name)
    setOpen(false)
  }
  const list = open ? createPortal(
    <div
      ref={menu}
      className={overlayMenuClass(box.current)}
      {...theme.attributes}
      role="listbox"
      data-db-parent-dialog={box.current?.closest('[data-db-dialog-id]')?.getAttribute('data-db-dialog-id')}
      style={{...theme.style,position:'fixed',...pos,zIndex:80}}
      onKeyDown={event=>listboxKeyDown(event,menu.current,()=>setOpen(false))}
    >
      {emptyLabel && value ? <button type="button" onClick={() => pick('')}>{emptyLabel}</button> : null}
      {(onMore ? filtered : filtered.slice(0, 40)).map(name => <button key={name} type="button" role="option" aria-selected={name===value} tabIndex={-1} className={name === value ? 'is-active' : ''} onClick={() => pick(name)}>{name}</button>)}
      {allowCustom && query && !filtered.includes(query) && <button type="button" role="option" tabIndex={-1} onClick={() => pick(query)}>使用输入值：{query}</button>}
      {error && <div className="db-resource-error" role="status">{error}{onRetry && <button type="button" onClick={onRetry}>重试加载</button>}</div>}
      {hasMore && <button type="button" disabled={loading} onClick={onMore}>加载更多候选</button>}
      {loading && !filtered.length && <button type="button" className="db-muted" onClick={() => setOpen(false)}>正在加载…</button>}
      {!loading && !filtered.length && !(emptyLabel && value) && <button type="button" className="db-muted" onClick={() => setOpen(false)}>没有匹配项。</button>}
    </div>,
    document.body,
  ) : null
  return <div className={`db-menu-owner db-search-select ${className}`.trim()} ref={box}>
    <input
      id={id}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid}
      className="db-search-select-input"
      aria-label={ariaLabel}
      aria-expanded={open}
      placeholder={placeholder}
      value={open ? query : value}
      onKeyDown={event=>{
        if (allowCustom && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); pick(query); return }
        listboxKeyDown(event,menu.current,()=>setOpen(false))
      }}
      onBlur={event=>{
        if (allowCustom && !menu.current?.contains(event.relatedTarget as Node)) onPick(query)
      }}
      onChange={e => {
        const wasOpen = open
        setQuery(e.target.value)
        setOpen(true)
        if (!wasOpen) onOpen?.()
        if (allowCustom) onPick(e.target.value)
        onSearch?.(e.target.value)
      }}
      onFocus={() => {
        const wasOpen = open
        setOpen(true)
        if (!wasOpen) onOpen?.()
        if (!wasOpen && query === value && !allowCustom) { setQuery(''); onSearch?.('') }
      }}
    />
    {list}
  </div>
}

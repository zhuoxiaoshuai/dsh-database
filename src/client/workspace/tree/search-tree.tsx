import React, { Children, useState } from 'react'
import { RefreshCw, Search, X } from 'lucide-react'
import { PaneGutter } from '../shell/pane-gutter.tsx'
import { TreeBranch } from './tree-branch.tsx'

/** Searchable tree plus the detail pane. The tree does not know which data source it is showing. */
export function SearchTreeSplit({ open, onOpenChange, openLabel, toggle, tree, title, actions, detail }: {
  open: boolean
  onOpenChange(open: boolean): void
  openLabel: string
  toggle: React.ReactNode
  tree: React.ReactNode
  title?: React.ReactNode
  actions?: React.ReactNode
  detail: React.ReactNode
}): React.ReactElement {
  return <div className={`db-search-tree-split${open ? ' is-open' : ''}`}>
    {open && <button type="button" className="db-search-tree-backdrop" aria-label={openLabel.replace('打开', '关闭')} onClick={() => onOpenChange(false)} />}
    {tree}
    <div className="db-search-tree-detail">
      <button type="button" className="db-search-tree-toggle db-btn" aria-label={openLabel} onClick={() => onOpenChange(true)}>{toggle}</button>
      {(title != null || actions != null) && <div className="db-object-head">
        {title != null && <strong>{title}</strong>}
        {actions}
      </div>}
      {detail}
    </div>
  </div>
}

export function SearchTree({ label, title, action, search, searchPlaceholder, resetSearchValue = '', refreshLabel = '刷新', onSearch, onSubmitSearch, onRefresh, busy, disabled,
  error, empty, children, footer, width, onResize }: {
  label: string
  title: React.ReactNode
  action?: React.ReactNode
  search: string
  searchPlaceholder?: string
  resetSearchValue?: string
  refreshLabel?: string
  onSearch(value: string): void
  onSubmitSearch(): void
  onRefresh(): void
  busy?: boolean
  disabled?: boolean
  error?: string
  empty?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  width?: number
  onResize?: React.PointerEventHandler<HTMLDivElement>
}): React.ReactElement {
  return <div className="db-search-tree" aria-label={label} style={width === undefined ? undefined : { '--db-search-tree-width': `${width}px` } as React.CSSProperties}>
    <div className="db-search-tree-head"><span>{title}</span>{action}</div>
    <div className="db-sidebar-toolbar">
      <div className="db-catalog-search"><Search size={15} /><input aria-label={label} placeholder={searchPlaceholder} value={search} onChange={event => onSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') onSubmitSearch() }} />{search && search !== resetSearchValue && <button className="db-icon-button" type="button" aria-label="重置匹配" onClick={() => onSearch(resetSearchValue)}><X size={12} /></button>}</div>
      <button className="db-icon-button" type="button" aria-label={refreshLabel} disabled={busy || disabled} onClick={onRefresh}><RefreshCw size={14} className={busy ? 'db-spin' : undefined} /></button>
    </div>
    <div className="db-search-tree-body db-conn-tree" aria-busy={busy || undefined}>
      {error && <p className="db-error" role="alert">{error}</p>}
      {Children.count(children) ? children : empty}
    </div>
    {footer && <div className="db-search-tree-foot">{footer}</div>}
    {onResize && <PaneGutter axis="x" onResize={onResize} />}
  </div>
}

/** Connection-tree row inside a search shell. `depth` is kept for callers; indent comes from nested branches. */
export function SearchTreeNode({ text, title, depth = 0, selected = false, count, icon, onSelect, folder = false, defaultOpen = false, onOpen, children }: {
  text: string
  title?: string
  depth?: number
  selected?: boolean
  count?: number
  icon?: React.ReactNode
  onSelect?(): void
  folder?: boolean
  defaultOpen?: boolean
  onOpen?(): void
  children?: React.ReactNode
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen)
  void depth
  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next) onOpen?.()
  }
  return <TreeBranch
    expanded={folder && open}
    selected={selected}
    showTwist={folder}
    twistLabel={open ? `折叠 ${text}` : `展开 ${text}`}
    onToggle={toggle}
    onSelect={() => onSelect?.()}
    row={<>
      {icon}
      <button type="button" className="db-tree-label" title={title ?? text} onClick={event => { event.stopPropagation(); onSelect?.() }}>{text}</button>
      {count === undefined ? null : <small className="db-search-tree-count">{count}</small>}
    </>}
  >
    {folder ? children : undefined}
  </TreeBranch>
}

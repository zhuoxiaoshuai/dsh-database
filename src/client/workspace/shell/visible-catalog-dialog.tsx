import React, { useMemo, useRef } from 'react'
import { Search, X } from 'lucide-react'
import { schemaNameListed, type CatalogChild } from '../../../shared/workbench.ts'
import {DialogFrame} from '../parts/overlay/dialog-frame.tsx'
import type { CatalogFilterCopy } from './catalog-filter-copy.ts'

export function VisibleCatalogDialog({
  open, items, draft, search, caseInsensitive, copy, onDraft, onSearch, onSave, onClose,
}: {
  open: boolean
  items: readonly CatalogChild[]
  draft: string[]
  search: string
  caseInsensitive?: boolean
  copy: CatalogFilterCopy
  onDraft(next: string[]): void
  onSearch(next: string): void
  onSave(): void
  onClose(): void
}) {
  const names = useMemo(() => items.filter(item => item.id), [items])
  const needle = search.trim().toLocaleLowerCase()
  const filtered = needle ? names.filter(item => item.label.toLocaleLowerCase().includes(needle)) : names
  if (!open) return null
  return <DialogFrame title={copy.title} ariaLabel={copy.ariaLabel} close={onClose} footer={names.length?<><button type="button" className="db-btn" onClick={()=>onDraft([])}>清空</button><button type="button" className="db-btn" onClick={onClose}>取消</button><button type="button" className="db-primary" onClick={onSave}>保存</button></>:<button type="button" className="db-primary" onClick={onClose}>关闭</button>}>
      <p className="db-muted">{copy.hint}</p>
      {names.length ? <>
        <div className="db-catalog-search">
          <Search size={15} />
          <input aria-label={copy.searchLabel} placeholder="搜索" value={search} onChange={event => onSearch(event.target.value)} />
          {search && <button type="button" className="db-icon-button" aria-label={copy.clearSearchLabel} onClick={() => onSearch('')}><X size={12} /></button>}
        </div>
        <div className="db-schema-filter-list" role="group" aria-label={copy.groupLabel}>
          {filtered.map(item => {
            const checked = schemaNameListed(draft, item.id, caseInsensitive)
            return <label key={item.id} className="db-schema-filter-item">
              <input
                type="checkbox"
                checked={checked}
                onChange={event => {
                  const next = event.target.checked
                  onDraft(next ? (checked ? draft : [...draft, item.id]) : draft.filter(id => caseInsensitive ? id.toLowerCase() !== item.id.toLowerCase() : id !== item.id))
                }}
              />
              <span>{item.label}</span>
            </label>
          })}
          {!filtered.length && <p className="db-muted">{copy.emptyMatch}</p>}
        </div>
      </> : <>
        <p className="db-info-note">{copy.emptyList}</p>
      </>}
  </DialogFrame>
}

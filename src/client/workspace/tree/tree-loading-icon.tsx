import React from 'react'
import { ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react'

export function TreeLoadingIcon({ label }: { label: string }): React.ReactElement {
  return <LoaderCircle size={14} className="db-tree-icon db-spin" aria-label={label} role="status" />
}

export function TreeTypeIcon({ loading, loadingLabel, children }: {
  loading: boolean
  loadingLabel: string
  children: React.ReactElement
}): React.ReactElement {
  return loading ? <TreeLoadingIcon label={loadingLabel} /> : children
}

export function TreeTwist({ onToggle, expanded, label }: { onToggle(): void; expanded: boolean; label: string }): React.ReactElement {
  return <button type="button" className="db-tree-twist" aria-label={label} aria-expanded={expanded} tabIndex={-1} onClick={event => {
    event.preventDefault()
    event.stopPropagation()
    onToggle()
  }}>
    <ChevronRight size={12} className="db-twist-closed" />
    <ChevronDown size={12} className="db-twist-open" />
  </button>
}

export function TreeRetryHint({ text, onRetry }: { text: string; onRetry(): void }): React.ReactElement {
  return <p className="db-muted db-tree-hint" role="alert">{text} <button type="button" className="db-text-button" onClick={event => { event.preventDefault(); event.stopPropagation(); onRetry() }}>重试</button></p>
}

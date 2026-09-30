import React from 'react'

export function GridSearchBar({
  query, index, total, inputRef, onQuery, onPrev, onNext, onClear,
}: {
  query: string
  index: number
  total: number
  inputRef: React.RefObject<HTMLInputElement>
  onQuery(value: string): void
  onPrev(): void
  onNext(): void
  onClear(): void
}): React.ReactElement {
  const shown = query.trim() ? (total ? `${index + 1}/${total}` : '0/0') : ''
  return <div className="db-grid-search" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }}>
    <input
      ref={inputRef}
      className="db-grid-search-input"
      value={query}
      aria-label="在当前结果中查找"
      placeholder="查找"
      onChange={event => onQuery(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Enter') {
          event.preventDefault()
          if (event.shiftKey) onPrev()
          else onNext()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          onClear()
        }
      }}
    />
    <span className="db-grid-search-count" aria-live="polite">{shown}</span>
    <button type="button" aria-label="上一条" disabled={!total} onClick={onPrev}>上一条</button>
    <button type="button" aria-label="下一条" disabled={!total} onClick={onNext}>下一条</button>
  </div>
}

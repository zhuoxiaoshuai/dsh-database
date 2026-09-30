import React from 'react'
import { TreeTwist } from './tree-loading-icon.tsx'

export function TreeBranch({
  expanded,
  selected,
  className,
  showTwist = true,
  twistLabel,
  onToggle,
  onSelect,
  onDoubleClick,
  onContextMenu,
  onMouseDown,
  row,
  children,
}: {
  expanded: boolean
  selected?: boolean
  className?: string
  showTwist?: boolean
  twistLabel: string
  onToggle(): void
  onSelect(): void
  onDoubleClick?: React.MouseEventHandler
  onContextMenu?: React.MouseEventHandler
  onMouseDown?: React.MouseEventHandler
  row: React.ReactNode
  children?: React.ReactNode
}): React.ReactElement {
  return <div className={`db-tree-branch ${expanded ? 'is-open' : ''} ${className || ''}`.trim()}>
    <div
      className={`db-tree-row${selected ? ' is-selected' : ''}`}
      onClick={event => { event.preventDefault(); onSelect() }}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onMouseDown={onMouseDown}
    >
      {showTwist
        ? <TreeTwist expanded={expanded} label={twistLabel} onToggle={onToggle} />
        : <span className="db-tree-twist db-tree-twist-empty" aria-hidden="true" />}
      {row}
    </div>
    {expanded && children != null ? <div className="db-tree-kids">{children}</div> : null}
  </div>
}

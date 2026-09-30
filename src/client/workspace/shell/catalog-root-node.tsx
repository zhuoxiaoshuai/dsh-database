import React from 'react'
import { Cylinder } from 'lucide-react'
import { TreeBranch } from '../tree/tree-branch.tsx'

/** Source-owned catalog root, shown like a database: select it, do not nest its contents here. */
export function CatalogRootNode({ label, selected, onSelect }: {
  label: string
  selected: boolean
  onSelect(): void
}): React.ReactElement {
  return <TreeBranch
    className="db-schema-node"
    expanded={false}
    selected={selected}
    showTwist={false}
    twistLabel={label}
    onToggle={() => onSelect()}
    onSelect={onSelect}
    row={<>
      <Cylinder size={14} className={`db-tree-icon db-tree-icon-schema ${selected ? 'is-current' : ''}`} />
      <span className="db-tree-label">{label}</span>
    </>}
  />
}

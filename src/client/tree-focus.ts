export type TreeFocus =
  | { kind: 'schema'; schema: string }
  | { kind: 'folder'; schema: string; folder: 'table' | 'view' }
  | { kind: 'table'; schema: string; table: string; objectKind: 'table' | 'view' }
  | { kind: 'column'; schema: string; table: string; objectKind: 'table' | 'view'; column: string }
  | { kind: 'index'; schema: string; table: string; index: string }

export function treeFocusKey(focus: TreeFocus | undefined): string {
  if (!focus) return ''
  switch (focus.kind) {
    case 'schema': return `schema:${focus.schema}`
    case 'folder': return `folder:${focus.schema}:${focus.folder}`
    case 'table': return `table:${focus.schema}:${focus.table}`
    case 'column': return `column:${focus.schema}:${focus.table}:${focus.column}`
    case 'index': return `index:${focus.schema}:${focus.table}:${focus.index}`
  }
}

export function isTreeFocusSelected(focus: TreeFocus | undefined, key: string): boolean {
  return treeFocusKey(focus) === key
}

import type { MutableRefObject } from 'react'
import { takePendingSchema, type PendingSchemaPick } from '../shared/workbench.ts'
import type { TreeFocus } from './tree-focus.ts'

export type ObjectKind = 'table' | 'view'

export type TreePaneActions = {
  activateSchema(name: string): void
  showHomeFolder(kind: ObjectKind): void
  focusTree(next: TreeFocus): void
  highlight(name: string, kind: ObjectKind): void
  openObject(schema: string, table: string, kind: ObjectKind): void
  openContextMenu(event: { clientX: number; clientY: number }, schema: string, table: string, kind: ObjectKind): void
  refresh(): void
  openSql(sql?: string): void
  openNamed(kind: 'ai' | 'templates'): void
}

export function consumePendingSchema(pendingRef: MutableRefObject<PendingSchemaPick | undefined>, connectionId: string): {
  schema: string
  folder?: ObjectKind
  open?: { table: string; kind: ObjectKind }
} {
  const { schema, folder, open, rest } = takePendingSchema(pendingRef.current, connectionId)
  pendingRef.current = rest
  return { schema, folder, open }
}

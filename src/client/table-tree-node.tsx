import React, { useEffect, useState } from 'react'
import {
  Columns, Eye, Key, KeyRound, ListTree, Table2, Type,
} from 'lucide-react'
import { indexRowsFromCatalog } from './catalog-indexes.ts'
import { TreeBranch } from './workspace/tree/tree-branch.tsx'
import { refreshCatalogLayer } from './schema/refresh.ts'
import type { SchemaCache } from './schema/schema-cache.ts'
import type { Connection } from '../shared/workbench.ts'
import { isTreeFocusSelected, type TreeFocus } from './tree-focus.ts'
import { TreeRetryHint, TreeTypeIcon } from './workspace/tree/tree-loading-icon.tsx'

type ObjectKind = 'table' | 'view'

export function TableTreeNode({
  schemaName, tableName, objectKind, connection, cache, treeFocus, onFocus, onHighlight, onSyncListHighlight, onOpen, onMenu,
}: {
  schemaName: string
  tableName: string
  objectKind: ObjectKind
  connection: Connection
  cache: SchemaCache
  treeFocus?: TreeFocus
  onFocus(next: TreeFocus): void
  onHighlight(name: string, kind: ObjectKind): void
  onSyncListHighlight(name: string, kind: ObjectKind): void
  onOpen(schemaName: string, tableName: string, kind: ObjectKind): void
  onMenu(event: React.MouseEvent, schemaName: string, tableName: string, kind: ObjectKind): void
}) {
  const [open, setOpen] = useState(false)
  const [fieldsOpen, setFieldsOpen] = useState(false)
  const [indexesOpen, setIndexesOpen] = useState(false)
  const detail = cache.detailSnapshot(connection, schemaName, tableName)
  const detailState = cache.detailStatus(connection, schemaName, tableName)
  const detailLoading = detailState?.status === 'loading'
  const detailError = detailState?.status === 'error' ? detailState.error : ''
  const indexesLoaded = (detail?.indexes as { status?: string } | undefined)?.status === 'actual'
  const indexesLoading = indexesOpen && !indexesLoaded && objectKind === 'table'
  const live = !!connection.live

  useEffect(() => {
    if (!fieldsOpen || !live) return
    const controller = new AbortController()
    void cache.loadTable(connection, schemaName, tableName, { signal: controller.signal }).catch(() => {})
    return () => controller.abort()
  }, [fieldsOpen, live, connection.id, connection.generation, cache, schemaName, tableName])
  useEffect(() => {
    if (!indexesOpen || !live || objectKind !== 'table') return
    const controller = new AbortController()
    void cache.loadIndexes(connection, schemaName, tableName, { signal: controller.signal }).catch(() => {})
    return () => controller.abort()
  }, [indexesOpen, live, objectKind, connection.id, connection.generation, cache, schemaName, tableName])

  const columns = (detail?.columns || []) as Record<string, unknown>[]
  const indexes = indexRowsFromCatalog(detail)
  const primary = new Set((detail?.primaryKeys || []).map(String))
  const selectTable = () => {
    onFocus({ kind: 'table', schema: schemaName, table: tableName, objectKind })
    onHighlight(tableName, objectKind)
  }

  return <TreeBranch
    className="db-table-node"
    expanded={open}
    selected={isTreeFocusSelected(treeFocus, `table:${schemaName}:${tableName}`)}
    twistLabel={open ? `折叠 ${tableName}` : `展开 ${tableName}`}
    onToggle={() => setOpen(value => !value)}
    onSelect={selectTable}
    onDoubleClick={event => { event.preventDefault(); selectTable(); onOpen(schemaName, tableName, objectKind) }}
    onContextMenu={event => { event.preventDefault(); selectTable(); onMenu(event, schemaName, tableName, objectKind) }}
    row={<>
      <TreeTypeIcon loading={detailLoading && fieldsOpen} loadingLabel={objectKind === 'view' ? '正在读取视图' : '正在读取表'}>
        {objectKind === 'view'
          ? <Eye size={14} className="db-tree-icon db-tree-icon-view" />
          : <Table2 size={14} className="db-tree-icon db-tree-icon-table" />}
      </TreeTypeIcon>
      <span className="db-tree-label">{tableName}</span>
    </>}
  >
    <TreeBranch
      className="db-meta-folder"
      expanded={fieldsOpen}
      twistLabel={fieldsOpen ? '折叠字段' : '展开字段'}
      onToggle={() => setFieldsOpen(value => !value)}
      onSelect={selectTable}
      row={<>
        <TreeTypeIcon loading={detailLoading} loadingLabel="正在读取字段">
          <Columns size={14} className="db-tree-icon db-tree-icon-fields" />
        </TreeTypeIcon>
        <span className="db-tree-label">字段</span>
      </>}
    >
      {columns.map(column => {
        const colName = String(column.name || '')
        const isPk = primary.has(colName) || /PRI/i.test(String(column.key || column.columnKey || ''))
        return <button key={colName} type="button" className={`db-tree-leaf ${isTreeFocusSelected(treeFocus, `column:${schemaName}:${tableName}:${colName}`) ? 'is-selected' : ''}`}
          onClick={event => {
            event.stopPropagation()
            onFocus({ kind: 'column', schema: schemaName, table: tableName, objectKind, column: colName })
            onSyncListHighlight(tableName, objectKind)
          }}
          onDoubleClick={() => { onHighlight(tableName, objectKind); onOpen(schemaName, tableName, objectKind) }}
          onContextMenu={event => { event.preventDefault(); onHighlight(tableName, objectKind); onMenu(event, schemaName, tableName, objectKind) }}>
          {isPk ? <Key size={14} className="db-tree-icon db-tree-icon-pk" /> : <Type size={14} className="db-tree-icon db-tree-icon-col" />}
          <span className="db-tree-label">{colName}</span>
        </button>
      })}
      {detailLoading && !columns.length && <p className="db-muted db-tree-hint">正在读取字段…</p>}
      {detailError && !columns.length && <TreeRetryHint text={detailError} onRetry={() => { void refreshCatalogLayer(cache, connection, { layer: 'table', schema: schemaName, table: tableName }).catch(() => {}) }} />}
      {!detailLoading && !detailError && !columns.length && <p className="db-muted db-tree-hint">没有字段</p>}
    </TreeBranch>
    {objectKind === 'table' && <TreeBranch
      className="db-meta-folder"
      expanded={indexesOpen}
      twistLabel={indexesOpen ? '折叠索引' : '展开索引'}
      onToggle={() => setIndexesOpen(value => !value)}
      onSelect={selectTable}
      row={<>
        <TreeTypeIcon loading={indexesLoading} loadingLabel="正在读取索引">
          <ListTree size={14} className="db-tree-icon db-tree-icon-indexes" />
        </TreeTypeIcon>
        <span className="db-tree-label">索引</span>
      </>}
    >
      {indexes.map(index => <button key={index.name} type="button" className={`db-tree-leaf ${isTreeFocusSelected(treeFocus, `index:${schemaName}:${tableName}:${index.name}`) ? 'is-selected' : ''}`}
        onClick={event => {
          event.stopPropagation()
          onFocus({ kind: 'index', schema: schemaName, table: tableName, index: index.name })
          onSyncListHighlight(tableName, objectKind)
        }}>
        <KeyRound size={14} className="db-tree-icon db-tree-icon-index" />
        <span className="db-tree-label">{index.name}</span>
      </button>)}
      {indexesLoading && !indexes.length && <p className="db-muted db-tree-hint">正在读取索引…</p>}
      {!indexesLoading && !indexes.length && <p className="db-muted db-tree-hint">没有索引</p>}
    </TreeBranch>}
  </TreeBranch>
}

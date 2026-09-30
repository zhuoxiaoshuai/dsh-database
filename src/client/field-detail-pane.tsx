import React, { useEffect, useState } from 'react'
import { KeyRound, Table2, Type } from 'lucide-react'
import { indexRowsFromCatalog } from './catalog-indexes.ts'
import { catalogLabels, catalogValue } from './table-structure.tsx'
import type { SchemaCache } from './schema/schema-cache.ts'
import type { Connection } from '../shared/workbench.ts'
import { dialectCapabilities } from '../shared/dialect-capabilities.ts'
import type { TreeFocus } from './tree-focus.ts'

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="db-field-detail-row"><span>{label}</span><strong>{value || '—'}</strong></div>
}

function focusTable(focus: TreeFocus | undefined): { schema: string; table: string } | undefined {
  if (!focus) return undefined
  if (focus.kind === 'table' || focus.kind === 'column' || focus.kind === 'index') return { schema: focus.schema, table: focus.table }
  return undefined
}

export function FieldDetailPane({
  connection, cache, schema, treeFocus, tableRecord,
}: {
  connection: Connection
  cache: SchemaCache
  schema: string
  treeFocus?: TreeFocus
  tableRecord?: Record<string, unknown>
}) {
  const [rev, setRev] = useState(0)
  const focused = focusTable(treeFocus)
  const metaSchema = focused?.schema || (treeFocus && 'schema' in treeFocus ? treeFocus.schema : schema)
  const metaTable = focused?.table || ''
  useEffect(() => cache.subscribe(() => setRev(n => n + 1)), [cache])
  useEffect(() => {
    if (!connection.live || !metaSchema) return
    if (treeFocus?.kind === 'schema' || treeFocus?.kind === 'folder') void cache.loadSchemaInfo(connection, metaSchema).catch(() => {})
  }, [cache, connection, metaSchema, treeFocus?.kind])
  useEffect(() => {
    if (!metaTable || !connection.live) return
    if (treeFocus?.kind === 'column') void cache.loadTable(connection, metaSchema, metaTable).catch(() => {})
    if (treeFocus?.kind === 'index') void cache.loadIndexes(connection, metaSchema, metaTable).catch(() => {})
  }, [cache, connection, metaSchema, metaTable, treeFocus?.kind])
  void rev
  const detailSnap = metaTable ? cache.detailSnapshot(connection, metaSchema, metaTable) : undefined
  const schemaInfo = metaSchema ? cache.schemaInfoSnapshot(connection, metaSchema) : undefined
  const schemaState = metaSchema ? cache.schemaInfoStatus(connection, metaSchema) : undefined
  const summary = schemaInfo?.summary && typeof schemaInfo.summary === 'object' && !Array.isArray(schemaInfo.summary)
    ? Object.entries(schemaInfo.summary as Record<string, unknown>)
    : []

  if (!treeFocus) {
    return <div className="db-field-detail-pane"><p className="db-muted">在左侧树中选择数据库、表、字段或索引查看详情。</p></div>
  }

  if (treeFocus.kind === 'schema' || treeFocus.kind === 'folder') {
    return <div className="db-field-detail-pane">
      <header className="db-field-detail-head"><CylinderIcon /><div>
        <strong>{treeFocus.kind === 'folder' ? (treeFocus.folder === 'view' ? '视图' : '表') : treeFocus.schema}</strong>
        <small>{treeFocus.kind === 'folder' ? treeFocus.schema : dialectCapabilities(connection.dialect).namespaceLabel}</small>
      </div></header>
      {schemaState?.status === 'loading' && !schemaInfo && <p className="db-muted">正在读取数据库信息…</p>}
      {summary.map(([key, value]) => <DetailRow key={key} label={catalogLabels[key] || key} value={catalogValue(value)} />)}
    </div>
  }

  if (treeFocus.kind === 'table') {
    const rec = tableRecord
    return <div className="db-field-detail-pane">
      <header className="db-field-detail-head"><Table2 size={28} className="db-tree-icon db-tree-icon-table" /><div><strong>{treeFocus.table}</strong><small>{treeFocus.objectKind === 'view' ? '视图' : '表'}</small></div></header>
      <DetailRow label="注释" value={String(rec?.comment || detailSnap?.comment || '')} />
      <DetailRow label="引擎" value={String(rec?.engine || rec?.tablespace || '')} />
      <DetailRow label="行数（估计）" value={rec?.estimatedRows == null ? '' : String(rec.estimatedRows)} />
    </div>
  }

  if (treeFocus.kind === 'column') {
    const column = ((detailSnap?.columns || []) as Record<string, unknown>[]).find(item => String(item.name) === treeFocus.column)
    const nullable = column?.nullable
    const nullLabel = nullable === true || String(nullable).toUpperCase() === 'YES' ? '是' : nullable === false || String(nullable).toUpperCase() === 'NO' ? '否' : String(nullable ?? '')
    return <div className="db-field-detail-pane">
      <header className="db-field-detail-head"><Type size={28} className="db-tree-icon db-tree-icon-col" /><div><strong>{treeFocus.column}</strong><small>字段 · {treeFocus.table}</small></div></header>
      <DetailRow label="类型" value={String(column?.type || '')} />
      <DetailRow label="不是 null" value={nullLabel} />
      <DetailRow label="注释" value={String(column?.comment || '')} />
    </div>
  }

  if (treeFocus.kind === 'index') {
    const index = indexRowsFromCatalog(detailSnap).find(item => item.name === treeFocus.index)
    return <div className="db-field-detail-pane">
      <header className="db-field-detail-head"><KeyRound size={28} className="db-tree-icon db-tree-icon-index" /><div><strong>{treeFocus.index}</strong><small>索引 · {treeFocus.table}</small></div></header>
      <DetailRow label="类型" value={index?.type || ''} />
      <DetailRow label="唯一" value={index?.unique === 'YES' ? '是' : index ? '否' : ''} />
      <DetailRow label="字段" value={index?.columns || ''} />
    </div>
  }

  return null
}

function CylinderIcon(): React.ReactElement {
  return <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="db-tree-icon db-tree-icon-schema is-current" aria-hidden="true"><ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v14c0 1.7 3.1 3 7 3s7-1.3 7-3V5" /></svg>
}

import React, { useEffect, useState } from 'react'
import type { Connection } from '../shared/workbench.ts'
import type { SchemaCache } from './schema/schema-cache.ts'

export function TableStructurePane({
  cache, connection, schema, table, onClose,
}: {
  cache: SchemaCache
  connection: Connection
  schema: string
  table: string
  onClose(): void
}) {
  const cached = cache.detailSnapshot(connection, schema, table)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(!cached)
  useEffect(() => {
    let alive = true
    setBusy(!cache.detailSnapshot(connection, schema, table))
    setError('')
    void cache.loadTable(connection, schema, table).catch(e => { if (alive) setError(e instanceof Error ? e.message : '无法读取结构') }).finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [cache, connection, schema, table])
  const detail = cache.detailSnapshot(connection, schema, table)
  return <div className="db-structure-pane" aria-label={`${table} 表结构`}>
    <h3>{table}<button type="button" className="db-icon-button" aria-label="关闭表结构" title="关闭表结构" onClick={onClose}>×</button></h3>
    {busy && <p className="db-info-note" role="status">正在读取字段…</p>}
    {error && <p className="db-error" role="alert">{error}</p>}
    {detail && <div className="db-grid-scroll"><table className="db-grid"><thead><tr><th>字段</th><th>类型</th><th>NULL</th><th>KEY</th><th>默认值</th><th>Extra</th></tr></thead>
      <tbody>{(detail.columns || []).map(column => <tr key={String(column.name)}>
        <td>{String(column.name)}</td>
        <td>{String(column.type || '')}</td>
        <td>{String(column.nullable ?? '')}</td>
        <td>{String(column.key || column.columnKey || '')}</td>
        <td>{column.defaultValue === undefined || column.defaultValue === null ? 'NULL' : String(column.defaultValue)}</td>
        <td>{String(column.extra || '')}</td>
      </tr>)}</tbody></table></div>}
  </div>
}

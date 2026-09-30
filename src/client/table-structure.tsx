import React, { useEffect, useState } from 'react'
import type { CatalogResult, Connection, WorkspaceBridge } from '../shared/workbench.ts'

export const catalogLabels: Record<string, string> = { objects: '对象数量', dataBytes: '数据大小（字节）', indexBytes: '索引大小（字节）', charset: '字符集', collation: '排序规则', name: '字段名', type: '类型', nullable: '允许空值', defaultValue: '默认值', defaultvalue: '默认值', comment: '注释', extra: '自增 / Identity', key: '键', precision: '精度', scale: '小数位', length: '长度' }
export const catalogValue = (v: unknown) => v === null || v === undefined ? '未提供' : typeof v === 'object' ? JSON.stringify(v) : String(v)
export function CatalogRows({ rows }: { rows: Record<string, unknown>[] }) {
  const columns = [...new Set(rows.flatMap(Object.keys))]
  return rows.length ? <div className="db-grid-scroll"><table className="db-grid"><thead><tr>{columns.map(k => <th key={k}>{catalogLabels[k] || k}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{columns.map(k => <td key={k}>{catalogValue(row[k])}</td>)}</tr>)}</tbody></table></div> : <p className="db-info-note">当前账号未返回此类信息。</p>
}
export function CatalogSection({ title, data }: { title: string; data: unknown }) {
  const result = data as { status?: string; reason?: string; values?: Record<string, unknown>[] } | undefined
  return <details open><summary>{title}</summary>{result?.status === 'unavailable' ? <p className="db-info-note">{result.reason}</p> : <CatalogRows rows={result?.values || []} />}</details>
}

export function TableStructure({
  bridge, connection, schema, table, onBrowse, onMaintain,
}: {
  bridge: WorkspaceBridge
  connection: Connection
  schema: string
  table: string
  onBrowse(): void
  onMaintain?(detail: CatalogResult): void
}) {
  const [detail, setDetail] = useState<CatalogResult>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    let alive = true
    setLoading(true); setError(''); setDetail(undefined)
    void bridge.catalog!(connection, { kind: 'table', schema, table }).then(value => {
      if (alive) setDetail(value)
    }).catch(e => { if (alive) setError(e instanceof Error ? e.message : '读取失败') }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [bridge, connection, schema, table])
  return <div className="db-catalog-structure" aria-label={`${table} 表结构`}>
    <h3>{table} · 表结构</h3>
    <div className="db-catalog-tools">
      <button disabled={loading} onClick={onBrowse}>浏览数据</button>
      {onMaintain && detail && <button disabled={loading} onClick={() => onMaintain(detail)}>维护表结构</button>}
    </div>
    {loading && <p className="db-info-note" role="status">正在读取表结构…</p>}
    {error && <p className="db-error" role="alert">{error}</p>}
    {detail && <>
      <CatalogRows rows={(detail.columns || []).slice(0, 500)} />
      <CatalogSection title="索引" data={detail.indexes} />
      <CatalogSection title="主外键、唯一及检查约束" data={detail.constraints} />
      {!!detail.storage && <CatalogSection title="表空间占用" data={detail.storage} />}
      <CatalogSection title="原始建表定义（不是数据备份）" data={detail.definition} />
      <p className="db-catalog-source">{detail.source} · {detail.collectedAt}{detail.truncated ? ' · 超出 500 字段，仅展示部分结构' : ''} · 只读展示，格式化不会改表元数据</p>
    </>}
  </div>
}

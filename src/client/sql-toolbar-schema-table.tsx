import React, { useEffect, useState } from 'react'
import { SearchSelect } from './search-select.tsx'
import type { SchemaCache } from './schema/schema-cache.ts'
import type { Connection } from '../shared/workbench.ts'

export function SqlToolbarSchemaTable({
  connection,
  schema,
  schemas,
  cache,
  onSchemaChange,
  picked,
  onPickTable,
}: {
  connection: Connection
  schema: string
  schemas: string[]
  cache: SchemaCache
  onSchemaChange(schema: string): void
  picked: string
  onPickTable(table: string): void
}) {
  const [, bump] = useState(0)
  const [tablesBusy, setTablesBusy] = useState(false)
  const schemaOptions = !schemas.length && schema
    ? [schema]
    : schemas.includes(schema) || !schema ? schemas : [...schemas, schema]
  useEffect(() => cache.subscribe(() => bump(n => n + 1)), [cache])
  const loadTables = (refresh = false) => {
    if (!schema || !connection.live) return
    const status = cache.tablesStatus(connection, schema)
    if (!refresh && (status?.status === 'ready' || status?.status === 'loading')) return
    setTablesBusy(true)
    void cache.loadTables(connection, schema, { refresh }).then(() => bump(n => n + 1)).catch(() => {}).finally(() => setTablesBusy(false))
  }
  useEffect(() => {
    if (!schema || !connection.live) return
    const status = cache.tablesStatus(connection, schema)
    if (status?.status === 'ready' || status?.status === 'loading') return
    setTablesBusy(true)
    void cache.loadTables(connection, schema).then(() => bump(n => n + 1)).catch(() => {}).finally(() => setTablesBusy(false))
  }, [cache, connection, schema])
  const tables = cache.tablesSnapshot(connection, schema) || []
  const tableNames = tables.filter(item => item.kind === 'table').map(item => item.name)
  const tablesLoading = tablesBusy || cache.tablesStatus(connection, schema)?.status === 'loading'
  return <>
    <SearchSelect
      value={schema}
      options={schemaOptions}
      onPick={onSchemaChange}
      placeholder="数据库"
      ariaLabel="切换数据库"
      className="db-schema-picker"
    />
    <SearchSelect
      value={picked}
      options={tableNames}
      onPick={onPickTable}
      placeholder="表结构"
      ariaLabel="选择表结构"
      className="db-table-picker"
      emptyLabel="不显示表结构"
      loading={tablesLoading}
      onOpen={() => loadTables(tableNames.length === 0)}
    />
  </>
}

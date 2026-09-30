import { resolvePrimaryKeys } from '../../primary-keys.mjs'
import { DRIVER_TIMEOUTS } from '../../request-timeouts.mjs'
import { boundedName, catalogOptions, checkCatalogAbort, normalizeIndexes, numberish, pageRows } from '../catalog-common.mjs'
import { sql as mysqlSql } from './driver.mjs'

const ident = value => mysqlSql.quote(boundedName(value))
const tableLists = new WeakMap()

function cachedTables(connection, schema, refresh) {
  let bySchema = tableLists.get(connection)
  if (!bySchema) { bySchema = new Map(); tableLists.set(connection, bySchema) }
  if (refresh) bySchema.delete(schema)
  return bySchema
}

const databaseName = row => String(row.Database ?? row.SCHEMA_NAME ?? row.name ?? '')
const tableRow = row => {
  const type = String(row.Table_type ?? row.TABLE_TYPE ?? row.kind ?? '')
  const name = String(row.name ?? Object.entries(row).find(([key]) => key !== 'Table_type' && key !== 'TABLE_TYPE')?.[1] ?? '')
  return { name, kind: /view/i.test(type) ? 'VIEW' : 'BASE TABLE' }
}
const columnRow = row => ({
  name: row.Field ?? row.COLUMN_NAME ?? row.name,
  type: row.Type ?? row.COLUMN_TYPE ?? row.type,
  nullable: row.Null ?? row.IS_NULLABLE ?? row.nullable,
  defaultValue: row.Default ?? row.COLUMN_DEFAULT ?? row.defaultValue,
  comment: row.Comment ?? row.COLUMN_COMMENT ?? row.comment,
  extra: row.Extra ?? row.EXTRA ?? row.extra,
  columnKey: row.Key ?? row.COLUMN_KEY ?? row.columnKey,
  key: row.Key ?? row.COLUMN_KEY ?? row.key,
  collation: row.Collation ?? row.collation,
})

export function statement(input) {
  catalogOptions(input)
  if (input.kind === 'schemas') return { sql: 'SHOW DATABASES', params: [] }
  const schema = boundedName(input.schema)
  if (input.kind === 'tables') return { sql: `SHOW FULL TABLES FROM ${ident(schema)}`, params: [] }
  if (input.kind === 'schema') return { sql: 'SELECT COUNT(*) AS objects,SUM(DATA_LENGTH) AS dataBytes,SUM(INDEX_LENGTH) AS indexBytes FROM information_schema.TABLES WHERE TABLE_SCHEMA=?', params: [schema] }
  const table = boundedName(input.table)
  if (input.kind === 'indexes') return { sql: `SHOW INDEX FROM ${ident(schema)}.${ident(table)}`, params: [] }
  if (input.kind === 'table') return { sql: `SHOW FULL COLUMNS FROM ${ident(schema)}.${ident(table)}`, params: [] }
  throw new Error('不支持的目录操作。')
}

export async function read(connection, input, signal) {
  checkCatalogAbort(signal)
  const request = statement(input)
  const collectedAt = new Date().toISOString()
  const offset = Number(input.offset ?? 0)
  const search = typeof input.search === 'string' ? input.search.slice(0, 128) : ''
  const query = async (text, params = []) => {
    checkCatalogAbort(signal)
    const result = params.length
      ? await connection.execute({ sql: text, timeout: DRIVER_TIMEOUTS.metadata }, params)
      : await connection.query({ sql: text, timeout: DRIVER_TIMEOUTS.metadata })
    return result[0]
  }
  if (input.kind === 'schemas') {
    const mapped = (await query(request.sql, request.params)).map(row => ({ name: databaseName(row) })).filter(row => row.name)
    return { ...pageRows(mapped, offset, search, row => String(row.name || '')), collectedAt, estimated: true, sql: request.sql, params: request.params, source: 'SHOW DATABASES · 当前账号可见库名' }
  }
  if (input.kind === 'tables') {
    const schema = boundedName(input.schema)
    const cache = cachedTables(connection, schema, input.refresh)
    let mapped = cache.get(schema)
    if (!mapped) {
      mapped = (await query(request.sql, request.params)).map(tableRow).filter(row => row.name)
      cache.set(schema, mapped)
    }
    return { ...pageRows(mapped, offset, search, row => String(row.name || '')), collectedAt, estimated: true, sql: request.sql, params: request.params, source: 'SHOW FULL TABLES · 当前库 Tables/Views' }
  }
  if (input.kind === 'schema') return { collectedAt, sql: request.sql, params: request.params, source: 'information_schema.TABLES · 仅当前库', estimated: true, summary: (await query(request.sql, request.params))[0] }
  if (input.kind === 'indexes') {
    const values = normalizeIndexes(await query(request.sql, request.params))
    return { indexes: { status: 'actual', values }, collectedAt, sql: request.sql, params: request.params, source: 'SHOW INDEX' }
  }
  const columns = (await query(request.sql, request.params)).map(column => ({
    ...columnRow(column), precision: numberish(column.precision), scale: numberish(column.scale), length: numberish(column.length),
  }))
  const primaryKeys = resolvePrimaryKeys('mysql', { columns })
  return { columns, indexes: { status: 'omitted', values: [] }, constraints: { status: 'omitted', values: [] }, primaryKeys, collectedAt, sql: request.sql, params: request.params, source: 'SHOW FULL COLUMNS', truncated: columns.length > 500 }
}

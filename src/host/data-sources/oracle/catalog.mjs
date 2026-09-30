import { resolvePrimaryKeys } from '../../primary-keys.mjs'
import { DRIVER_TIMEOUTS } from '../../request-timeouts.mjs'
import { boundedName, catalogOptions, checkCatalogAbort, normalizeConstraints, normalizeIndexes, numberish } from '../catalog-common.mjs'

export function statement(input) {
  const { offset, search } = catalogOptions(input)
  if (input.kind === 'schemas') return { sql: "SELECT owner AS name, SUM(CASE WHEN object_type='TABLE' THEN 1 ELSE 0 END) AS tables, SUM(CASE WHEN object_type='VIEW' THEN 1 ELSE 0 END) AS views FROM all_objects WHERE COALESCE(INSTR(owner, :1),1)>0 GROUP BY owner ORDER BY owner OFFSET " + offset + ' ROWS FETCH NEXT 101 ROWS ONLY', params: [search.toUpperCase()] }
  const schema = boundedName(input.schema)
  if (input.kind === 'tables') return search
    ? { sql: `SELECT o.object_name AS name,o.object_type AS kind,c.comments AS "comment",t.num_rows AS "estimatedRows",t.tablespace_name AS tablespace,t.last_analyzed AS "statisticsAt",o.created AS "createdAt",o.last_ddl_time AS "updatedAt" FROM all_objects o LEFT JOIN all_tables t ON t.owner=o.owner AND t.table_name=o.object_name LEFT JOIN all_tab_comments c ON c.owner=o.owner AND c.table_name=o.object_name WHERE o.owner=:1 AND o.object_type IN ('TABLE','VIEW') AND (COALESCE(INSTR(UPPER(o.object_name),UPPER(:2)),1)>0 OR EXISTS(SELECT 1 FROM all_tab_columns x WHERE x.owner=o.owner AND x.table_name=o.object_name AND INSTR(UPPER(x.column_name),UPPER(:3))>0)) ORDER BY o.object_name OFFSET ${offset} ROWS FETCH NEXT 101 ROWS ONLY`, params: [schema, search, search] }
    : { sql: `SELECT o.object_name AS name,o.object_type AS kind,c.comments AS "comment",t.num_rows AS "estimatedRows",t.tablespace_name AS tablespace,t.last_analyzed AS "statisticsAt",o.created AS "createdAt",o.last_ddl_time AS "updatedAt" FROM all_objects o LEFT JOIN all_tables t ON t.owner=o.owner AND t.table_name=o.object_name LEFT JOIN all_tab_comments c ON c.owner=o.owner AND c.table_name=o.object_name WHERE o.owner=:1 AND o.object_type IN ('TABLE','VIEW') ORDER BY o.object_name OFFSET ${offset} ROWS FETCH NEXT 101 ROWS ONLY`, params: [schema] }
  if (input.kind === 'schema') return { sql: "SELECT COUNT(*) AS objects FROM all_objects WHERE owner=:1 AND object_type IN ('TABLE','VIEW')", params: [schema] }
  boundedName(input.table)
  if (input.kind === 'indexes') throw new Error('不支持的目录操作。')
  if (input.kind === 'table') return { sql: 'SELECT c.column_name AS name,c.data_type AS type,c.nullable,c.data_default AS "defaultValue",m.comments AS "comment",c.identity_column AS extra,c.data_precision AS precision,c.data_scale AS scale,c.char_length AS length FROM all_tab_columns c LEFT JOIN all_col_comments m ON m.owner=c.owner AND m.table_name=c.table_name AND m.column_name=c.column_name WHERE c.owner=:1 AND c.table_name=:2 ORDER BY c.column_id FETCH FIRST 501 ROWS ONLY', params: [schema, input.table] }
  throw new Error('不支持的目录操作。')
}

export async function read(connection, input, signal) {
  checkCatalogAbort(signal)
  const request = statement(input)
  const collectedAt = new Date().toISOString()
  const schema = input.kind === 'schemas' ? '' : boundedName(input.schema)
  const table = input.kind === 'table' ? boundedName(input.table) : ''
  const oldTimeout = connection.callTimeout
  connection.callTimeout = DRIVER_TIMEOUTS.metadata
  try {
    const query = async (text, params = []) => {
      checkCatalogAbort(signal)
      const oracle = (await import('oracledb')).default
      const result = await connection.execute(text, params, { outFormat: oracle.OUT_FORMAT_OBJECT, maxRows: 501, fetchTypeHandler: meta => [oracle.DB_TYPE_NUMBER, oracle.DB_TYPE_DATE, oracle.DB_TYPE_TIMESTAMP, oracle.DB_TYPE_TIMESTAMP_TZ, oracle.DB_TYPE_TIMESTAMP_LTZ].includes(meta.dbType) ? { type: oracle.STRING } : undefined })
      return result.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value])))
    }
    const optional = async (text, params) => { try { return { status: 'actual', values: await query(text, params) } } catch { return { status: 'unavailable', reason: '当前账号无权读取，或该版本不支持此项字典信息。' } } }
    if (input.kind === 'schemas') {
      const rows = await query(request.sql, request.params)
      return { items: rows.slice(0, 100), more: rows.length > 100, collectedAt, estimated: true, sql: request.sql, params: request.params, source: 'ALL_OBJECTS · 当前账号可见 Schema 及表/视图数量' }
    }
    if (input.kind === 'tables') {
      const rows = await query(request.sql, request.params)
      return { items: rows.slice(0, 100), more: rows.length > 100, collectedAt, estimated: true, sql: request.sql, params: request.params, source: 'ALL_TABLES / ALL_OBJECTS · 最近统计行数' }
    }
    if (input.kind === 'schema') return { collectedAt, sql: request.sql, params: request.params, source: 'ALL_OBJECTS / DBA_SEGMENTS · 当前账号可见对象', estimated: true, summary: (await query(request.sql, request.params))[0], storage: await optional("SELECT s.tablespace_name,SUM(s.bytes) AS bytes FROM dba_segments s WHERE s.owner=:1 AND EXISTS (SELECT 1 FROM all_objects o WHERE o.owner=s.owner AND o.object_name=s.segment_name) GROUP BY s.tablespace_name", [schema]) }
    if (input.kind !== 'table') throw new Error('不支持的目录操作。')
    const columns = (await query(request.sql, request.params)).map(column => ({ ...column, precision: numberish(column.precision), scale: numberish(column.scale), length: numberish(column.length) }))
    const indexes = await optional('SELECT i.index_name,i.uniqueness,i.index_type,c.column_name,c.column_position FROM all_indexes i LEFT JOIN all_ind_columns c ON c.index_owner=i.owner AND c.index_name=i.index_name WHERE i.table_owner=:1 AND i.table_name=:2 ORDER BY i.index_name,c.column_position FETCH FIRST 501 ROWS ONLY', [schema, table])
    if (indexes.status === 'actual') indexes.values = normalizeIndexes(indexes.values)
    const constraints = await optional('SELECT c.constraint_name,c.constraint_type,c.status,c.r_owner,c.r_constraint_name,c.delete_rule,c.search_condition_vc,k.column_name,k.position FROM all_constraints c LEFT JOIN all_cons_columns k ON k.owner=c.owner AND k.constraint_name=c.constraint_name WHERE c.owner=:1 AND c.table_name=:2 ORDER BY c.constraint_name,k.position FETCH FIRST 501 ROWS ONLY', [schema, table])
    if (constraints.status === 'actual') constraints.values = normalizeConstraints(constraints.values)
    const storage = await optional("SELECT segment_type,tablespace_name,SUM(bytes) AS bytes FROM dba_segments WHERE owner=:1 AND (segment_name=:2 OR segment_name IN (SELECT index_name FROM all_indexes WHERE table_owner=:3 AND table_name=:4)) GROUP BY segment_type,tablespace_name", [schema, table, schema, table])
    let definition = { status: 'unavailable', reason: '当前账号无权读取原始定义，或定义超过 200,000 字符显示上限。' }
    let lob
    try {
      const result = await connection.execute("SELECT DBMS_METADATA.GET_DDL('TABLE',:1,:2) FROM DUAL", [table, schema])
      lob = result.rows[0]?.[0]
      if (lob && lob.length <= 200000) definition = { status: 'actual', values: [{ ddl: await lob.getData(1, Math.max(1, lob.length)) }] }
    } catch {} finally { if (lob) await lob.close().catch(() => {}) }
    const primaryKeys = resolvePrimaryKeys('oracle', { columns, indexes, constraints })
    return { columns, indexes, constraints, storage, definition, primaryKeys, collectedAt, sql: request.sql, params: request.params, source: 'ALL_TAB_COLUMNS / ALL_CONSTRAINTS / ALL_INDEXES', truncated: columns.length > 500 }
  } finally {
    connection.callTimeout = oldTimeout
  }
}

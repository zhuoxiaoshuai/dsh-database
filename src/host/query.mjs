import { authorizeSelect, authorizeStatement, splitStatements } from './query-policy.mjs'
import { isWritableEnvironment } from './shared/connection-permission.mjs'
import { cancelledError } from './query-pool.mjs'
import { SESSION_QUOTA, createQueryPool } from './session-manager.mjs'
import { rejectDatabaseError } from './connect-error.mjs'
import { DEFAULT_QUERY_PAGE_SIZE } from './shared/limits.mjs'
import { getDialect } from './dialects/registry.mjs'
import { getDataSource } from './data-sources/sql-registry.mjs'

export const MYSQL_TABLE_TYPE_SQL = getDialect('mysql').sql.writableObjectStatement('', '').sql
export const ORACLE_OBJECT_TYPE_SQL = getDialect('oracle').sql.writableObjectStatement('', '').sql

export function createDatabaseQueryPool(credentials) {
  const source = getDataSource(credentials.dialect)
  const dialect = source.driver
  return createQueryPool({
    size: SESSION_QUOTA.query,
    async create() {
      return dialect.openQuery(credentials)
    },
    async prepare(db, schema) {
      await dialect.prepareReadonly(db, schema)
    },
    async reset(db) {
      await dialect.reset(db)
    },
    async destroy(db) {
      await dialect.destroy(db)
    },
    isFatal: source.recovery.isFatalQuery,
  })
}

async function openEphemeralSelectSession(credentials, schema) {
  const dialect = getDialect(credentials.dialect)
  const db = await dialect.openQuery(credentials, { schema })
  await dialect.prepareReadonly(db, schema)
  return db
}

// 执行计划采集：MySQL EXPLAIN [FORMAT=JSON] / Oracle EXPLAIN PLAN FOR → DBMS_XPLAN.DISPLAY
export async function executeExplain(input, credentials, signal, authorized) {
  if (signal?.aborted) throw cancelledError('已取消。')
  const start = Date.now()
  const policy = authorized || await authorizeStatement(credentials.dialect, input.sql, input.schema)
  if (policy.kind !== 'explain') throw new Error('此入口仅执行 EXPLAIN。')
  const dialect = getDialect(credentials.dialect)
  let db
  const abort = () => { try { dialect.cancel(db) } catch { /* best-effort */ } }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    db = await dialect.openQuery(credentials, { schema: input.schema, rowsAsArray: true, probe: false })
    await dialect.prepareWrite(db, input.schema)
    const result = await dialect.executeExplain(db, policy.sql)
    return { ...result, truncated: false, elapsedMs: Date.now() - start, message: dialect.explainMessage }
  } catch (error) {
    if (signal?.aborted) throw cancelledError('已取消。')
    if (error instanceof Error && error.message.startsWith('数据库实例或账号')) throw error
    throw new Error(driverQueryError(error))
  } finally {
    signal?.removeEventListener('abort', abort)
    await dialect.destroy(db)
  }
}

// 执行只读 SHOW：MySQL SHOW INDEX / SHOW TABLE STATUS
export async function executeShow(input, credentials, signal, authorized) {
  if (signal?.aborted) throw cancelledError('已取消。')
  const start = Date.now()
  const policy = authorized || await authorizeStatement(credentials.dialect, input.sql, input.schema)
  if (policy.kind !== 'show') throw new Error('此入口仅执行 SHOW INDEX / SHOW TABLE STATUS。')
  const dialect = getDialect(credentials.dialect)
  if (!getDataSource(credentials.dialect).capabilities.showStatement || typeof dialect.executeShow !== 'function') throw new Error('SHOW 仅支持 MySQL。')
  let db
  const abort = () => { try { dialect.cancel(db) } catch { /* best-effort */ } }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    db = await dialect.openQuery(credentials, { schema: input.schema, rowsAsArray: true, probe: false })
    const { rows, columns } = await dialect.executeShow(db, policy.sql)
    const limited = rows.slice(0, 500)
    return { columns, rows: limited.map(r => r.map(v => v === null ? null : String(v))), truncated: rows.length > 500, elapsedMs: Date.now() - start, message: 'SHOW 统计 · 只读会话 · 未发送 AI' }
  } catch (error) {
    if (signal?.aborted) throw cancelledError('已取消。')
    if (error instanceof Error && error.message.startsWith('数据库实例或账号')) throw error
    throw new Error(driverQueryError(error))
  } finally {
    signal?.removeEventListener('abort', abort)
    await dialect.destroy(db)
  }
}

export function blockedWriteObjectMessage(objectType) {
  const type = String(objectType || '').trim().toUpperCase()
  if (type === 'TABLE' || type === 'BASE TABLE') return
  if (type === 'SYNONYM') throw new Error('同义词不支持维护，暂不开放写入。')
  if (type.includes('VIEW')) throw new Error('视图只读，不允许通过 SQL 页写入。')
  throw new Error('无法确认写入目标为普通表。')
}

function objectTypeFromRow(row) {
  if (row == null) return ''
  if (Array.isArray(row)) return row[0]
  return row.type || row.TABLE_TYPE || row.object_type || row.OBJECT_TYPE || ''
}

export async function assertWritableTargets(dialect, targets, queryRows) {
  if (!Array.isArray(targets) || !targets.length) throw new Error('无法确认写入目标对象。')
  const seen = new Set()
  for (const target of targets) {
    const schema = target?.schema, name = target?.name
    if (typeof schema !== 'string' || !schema || typeof name !== 'string' || !name) throw new Error('无法确认写入目标对象。')
    const key = schema + '\0' + name
    if (seen.has(key)) continue
    seen.add(key)
    const statement = getDialect(dialect).sql.writableObjectStatement(schema, name)
    const rows = await queryRows(statement.sql, statement.params)
    blockedWriteObjectMessage(objectTypeFromRow(rows?.[0]))
  }
}
function driverQueryError(error) {
  return rejectDatabaseError(error)
}

function appendSelectRow(rows, bytes, limit, values) {
  const size = Buffer.byteLength(JSON.stringify(values))
  if (rows.length === limit || bytes + size > 1024 * 1024 - 16384) return { rows, bytes, truncated: true }
  rows.push(values)
  return { rows, bytes: bytes + size, truncated: false }
}

// Each query owns an independent, read-only session; closing it cannot commit pending maintenance.
export async function executeSelect(input, credentials, signal, extras = {}) {
  if (signal?.aborted) throw cancelledError('读取已取消。')
  const start = Date.now(), limit = Number(input.limit ?? DEFAULT_QUERY_PAGE_SIZE)
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('查询行数必须在 1 到 500 之间。')
  const authorizeAt = Date.now()
  const authorized = extras.authorized || await authorizeSelect(credentials.dialect, input.sql, input.schema)
  const authorizeMs = extras.authorized ? 0 : Date.now() - authorizeAt
  if (authorized.kind !== 'select') throw new Error('只允许单条 SELECT。')
  const params = input.params ?? []
  if (!Array.isArray(params) || params.length > 8 || params.some(v => typeof v !== 'string' || v.length > 4096)) throw new Error('查询参数无效。')
  let db, truncated = false
  const dialect = getDialect(credentials.dialect)
  const recovery = getDataSource(credentials.dialect).recovery
  const timings = { authorizeMs, acquireMs: 0, sessionMs: 0, executeMs: 0 }
  const abort = () => {
    try {
      dialect.cancel(db)
    } catch { /* best-effort cancel of this session only */ }
  }
  signal?.addEventListener('abort', abort, { once: true })
  const fetchRows = async () => dialect.runSelect(db, authorized.sql, params, limit, appendSelectRow)
  try {
    if (!extras.pool) {
      const acquireAt = Date.now()
      db = await openEphemeralSelectSession(credentials, input.schema)
      timings.sessionMs = Date.now() - acquireAt
      const executeAt = Date.now()
      const fetched = await fetchRows()
      timings.executeMs = Date.now() - executeAt
      truncated = fetched.truncated
      if (signal?.aborted) throw cancelledError('读取已取消。')
      signal?.removeEventListener('abort', abort)
      return { columns: fetched.columns, rows: fetched.rows, truncated, elapsedMs: Date.now() - start, message: `${truncated ? '已到结果上限 · ' : ''}人工原值 · 只读会话 · 未发送 AI`, timings }
    }
    let retried = false
    for (let attempt = 0; ; attempt += 1) {
      const acquireAt = Date.now()
      const leased = await extras.pool.acquire(input.schema, signal)
      db = leased.connection
      timings.acquireMs += Date.now() - acquireAt
      try {
        const executeAt = Date.now()
        const fetched = await fetchRows()
        timings.executeMs += Date.now() - executeAt
        truncated = fetched.truncated
        if (signal?.aborted) throw cancelledError('读取已取消。')
        signal?.removeEventListener('abort', abort)
        if (truncated) await leased.discard()
        else await leased.release()
        if (retried) timings.retried = true
        return { columns: fetched.columns, rows: fetched.rows, truncated, elapsedMs: Date.now() - start, message: `${truncated ? '已到结果上限 · ' : ''}人工原值 · 只读会话 · 未发送 AI`, timings }
      } catch (error) {
        // Only a broken session is thrown away; SQL errors keep the pooled connection usable.
        if (recovery.isFatalQuery(error, { aborted: signal?.aborted, truncated, cancelled: error?.cancelled })) await leased.discard()
        else await leased.release()
        if (attempt === 0 && recovery.shouldRetryReadonly(error, { aborted: signal?.aborted, cancelled: error?.cancelled })) {
          retried = true
          continue
        }
        throw error
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    if (!extras.pool && db) {
      await dialect.destroy(db)
    }
  }
}

// SQL 页直接写入：人工通道全环境可写并自动提交；其它入口仍仅 SIT。连接中断即回滚未提交变更。
export async function executeDml(input, credentials, signal, authorized) {
  const manual = input?.lane === 'manual'
  if (!manual && !isWritableEnvironment(credentials.environment)) throw new Error('该连接为只读权限，SQL 页写入已禁用；请使用 SIT 可编辑连接。')
  const dialect = getDialect(credentials.dialect)
  if (signal?.aborted) throw cancelledError('执行已取消。')
  const start = Date.now()
  const policy = authorized || await authorizeStatement(credentials.dialect, input.sql, input.schema)
  if (policy.kind !== 'write') throw new Error('此入口仅执行 INSERT/UPDATE/DELETE。')
  let db
  const abort = () => { try { dialect.cancel(db) } catch { /* 中断即回滚未提交变更 */ } }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    db = await dialect.openQuery(credentials, { schema: input.schema, rowsAsArray: false, probe: false })
    await dialect.prepareWrite(db, input.schema)
    await dialect.verifyWritableTargets(db, policy.targets, assertWritableTargets)
    const affected = await dialect.executeWrite(db, policy.sql)
    return { columns: [], rows: [], truncated: false, affectedRows: affected, elapsedMs: Date.now() - start, message: `已提交 · 影响 ${affected} 行 · 人工直接提交 · 未发送 AI` }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('数据库实例或账号')) throw error
    if (error instanceof Error && /视图只读|同义词不支持|无法确认写入目标/.test(error.message)) throw error
    if (signal?.aborted) throw Object.assign(new Error('执行已取消，未提交的变更已回滚。'), { cancelled: true })
    if (error instanceof Error && /timeout|timed out|ETIMEDOUT|PROTOCOL_SEQUENCE_TIMEOUT/i.test(`${error.message} ${error.code || ''}`)) throw new Error('写入超时已中断连接，未提交的变更已回滚。')
    throw new Error(driverQueryError(error))
  } finally {
    signal?.removeEventListener('abort', abort)
    await dialect.destroy(db)
  }
}

// SQL 页统一入口：按授权分类分流查询 / 写入 / 执行计划 / SHOW 统计。
export async function executeSql(input, credentials, signal, pool, trustedAuthorization) {
  const start = Date.now()
  const parts = splitStatements(input.sql, credentials.dialect)
  if (parts.length > 1) {
    const batch = []
    let affectedRows = 0
    for (const part of parts) {
      const one = await executeSql({ ...input, sql: part }, credentials, signal, pool)
      const { batch: _nested, timings: _timings, ...set } = one
      batch.push({ ...set, sql: part })
      affectedRows += Number(one?.affectedRows || 0)
    }
    const last = batch.at(-1)
    return {
      ...last,
      sql: input.sql,
      affectedRows,
      elapsedMs: Date.now() - start,
      timings: { authorizeMs: 0 },
      message: `已执行 ${batch.length} 条 · ${last?.message || ''}`,
      batch,
    }
  }
  const authorized = trustedAuthorization || await authorizeStatement(credentials.dialect, input.sql, input.schema)
  const authorizeMs = trustedAuthorization ? 0 : Date.now() - start
  let result
  if (authorized.kind === 'write') result = await executeDml({ ...input, lane: input.lane === 'manual' ? 'manual' : 'query' }, credentials, signal, authorized)
  else if (authorized.kind === 'explain') result = await executeExplain(input, credentials, signal, authorized)
  else if (authorized.kind === 'show') result = await executeShow(input, credentials, signal, authorized)
  else result = await executeSelect(input, credentials, signal, { authorized, pool })
  return { ...result, elapsedMs: Date.now() - start, timings: { authorizeMs, ...(result.timings || {}) } }
}

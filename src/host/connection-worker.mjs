// Profile worker: credentials stay here. SessionManager owns Catalog / Query / Maintenance sessions.
import { parentPort } from 'node:worker_threads'
import { catalog } from './catalog.mjs'
import { executeSql, executeSelect, createDatabaseQueryPool } from './query.mjs'
import { buildBrowse } from './browse.mjs'
import { Maintenance, MaintenanceError } from './maintenance.mjs'
import { nativeErrorText } from './connect-error.mjs'
import { cancelledError, createSessionManager, startIdleCatalogProbe } from './session-manager.mjs'
import { getSqlDataSource } from './data-sources/sql-registry.mjs'

const FALLBACK_REQUEST_ERROR = '操作未完成：对象不可访问、请求超限或数据库版本不支持。请刷新后重试。'
const PUBLIC_ERROR_CODES = new Set([
  'connection_offline', 'connection_stale', 'connection_closed', 'session_invalid',
  'connection_busy', 'connection_timeout', 'request_cancelled',
])
const publicRequestError = error => {
  const message = error instanceof MaintenanceError
    ? nativeErrorText(error.message) || FALLBACK_REQUEST_ERROR
    : nativeErrorText(error, FALLBACK_REQUEST_ERROR)
  const code = PUBLIC_ERROR_CODES.has(error?.code)
    ? error.code
    : error?.cancelled ? 'request_cancelled' : undefined
  return { message, code }
}

function trustedAuthorization(value, sql) {
  if (!value || typeof value !== 'object') return undefined
  if (!['select', 'write', 'explain', 'show'].includes(value.kind)) return undefined
  if (typeof value.sql !== 'string' || value.sql !== sql) return undefined
  if (!Array.isArray(value.tables) || value.tables.some(item => typeof item !== 'string')) return undefined
  if (value.targets !== undefined && (!Array.isArray(value.targets) || value.targets.some(target =>
    !target || typeof target !== 'object' || typeof target.schema !== 'string' || typeof target.name !== 'string'))) return undefined
  return {
    kind: value.kind,
    sql: value.sql,
    tables: value.tables,
    ...(value.targets ? { targets: value.targets } : {}),
  }
}

parentPort.once('message', async ({ input, testOnly }) => {
  const started = Date.now()
  const credentials = { ...input }
  let ready = false
  try {
    const source = getSqlDataSource(input.dialect)
    source.connection.validateTarget(input.database, input.oracleMode)
    const dialect = source.driver
    if (testOnly) {
      const conn = await dialect.openCatalog(input)
      try {
        const probed = await dialect.probe(conn, input, { identity: false, temporal: false })
        input.password = ''
        parentPort.postMessage({
          ok: true,
          ready: true,
          result: { version: probed.version, database: probed.database, databases: [], elapsedMs: Date.now() - started },
        })
      } finally {
        await dialect.destroy(conn)
      }
      return
    }

    const sessions = createSessionManager({
      dialect: credentials.dialect,
      recovery: source.recovery,
      createCatalog: () => dialect.openCatalog(credentials),
      createMaintenance: () => dialect.openMaintenance(credentials),
      destroy: conn => dialect.destroy(conn),
      cancel: conn => dialect.cancel(conn),
      probe: async conn => {
        const probed = await dialect.probe(conn, credentials)
        credentials.identity = probed.identity
        return probed
      },
      createQueryPool: () => createDatabaseQueryPool(credentials),
      onHealth: health => { if (ready) parentPort.postMessage({ health }) },
      watchConnection: dialect.watchConnection,
    })

    const inflight = new Map()
    let catalogTail = Promise.resolve()
    const exclusive = fn => {
      const next = catalogTail.then(fn, fn)
      catalogTail = next.then(() => {}, () => {})
      return next
    }
    const maintenance = new Maintenance(
      () => sessions.catalogConnection(),
      credentials,
      () => sessions.acquireMaintenance(),
      () => sessions.releaseMaintenance(true),
    )
    const stopProbe = credentials.dialect === 'mysql'
      ? startIdleCatalogProbe(sessions, exclusive, () => !ready || inflight.size > 0) : () => {}

    parentPort.on('close', () => { ready = false; stopProbe(); void sessions.close() })
    parentPort.on('message', async message => {
      if (message.cancel && message.requestId) {
        inflight.get(message.requestId)?.abort()
        return
      }
      if (!message.requestId) return
      if (!ready && message.action !== 'reconnect') {
        parentPort.postMessage({ requestId: message.requestId, error: '连接尚未就绪。', stage: 'connect', retryable: false })
        return
      }
      const controller = new AbortController()
      inflight.set(message.requestId, controller)
      const run = async () => {
        if (!['catalog', 'query', 'browse', 'maintenance', 'manual-query', 'reconnect', 'revive'].includes(message.action)) throw new Error('此操作尚未开放。')
        if (controller.signal.aborted) throw cancelledError()
        let result
        if (message.action === 'reconnect') {
          result = await exclusive(async () => {
            const probed = await sessions.reconnect()
            credentials.identity = probed.identity
            return { version: probed.version, database: probed.database, elapsedMs: Date.now() - started, health: sessions.health }
          })
        } else if (message.action === 'revive') {
          result = await exclusive(async () => {
            await sessions.recoverCatalog()
            credentials.identity = sessions.identity
            return { version: sessions.version, database: sessions.database, elapsedMs: Date.now() - started, health: sessions.health }
          })
        } else if (message.action === 'maintenance') {
          result = await exclusive(() => maintenance.request(message.input, progress => parentPort.postMessage({ requestId: message.requestId, progress })))
        } else if (message.action === 'catalog') {
          result = await exclusive(() => sessions.withCatalog(conn => catalog(conn, input.dialect, message.input, controller.signal), controller.signal))
        } else if (message.action === 'query' || message.action === 'manual-query') {
          const { lane: _ignored, ...rest } = message.input || {}
          const authorized = trustedAuthorization(message.authorized, rest.sql)
          result = await executeSql({ ...rest, lane: message.lane === 'manual' || message.action === 'manual-query' ? 'manual' : 'query' }, credentials, controller.signal, sessions.queryPool(), authorized, sqlProgress => parentPort.postMessage({ requestId: message.requestId, sqlProgress }))
        } else {
          const metadata = await exclusive(() => sessions.withCatalog(conn => catalog(conn, input.dialect, { kind: 'table', schema: message.input.schema, table: message.input.table }, controller.signal), controller.signal))
          const plan = buildBrowse(input.dialect, message.input, metadata)
          result = { ...await executeSelect(plan, credentials, controller.signal, { pool: sessions.queryPool() }), generatedSql: plan.sql, warning: plan.warning }
        }
        if ((message.action === 'catalog' || message.action === 'maintenance') && Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) {
          throw new Error(message.action === 'catalog'
            ? '元数据超过 1 MiB，请缩小检索范围。'
            : '维护结果超过 1 MiB，请减少本次操作。')
        }
        return result
      }
      try {
        const result = await run()
        if (controller.signal.aborted && result?.affectedRows === undefined && !result?.steps?.some(step => step.status === 'succeeded')) parentPort.postMessage({ requestId: message.requestId, cancelled: true, error: '读取已取消。', stage: message.action, retryable: false })
        else parentPort.postMessage({ requestId: message.requestId, result, health: sessions.health })
      } catch (error) {
        const published = publicRequestError(error)
        parentPort.postMessage({
          requestId: message.requestId,
          cancelled: !!error?.cancelled || controller.signal.aborted,
          error: published.message,
          effect: error?.effect,
          phase: error?.phase,
          category: error?.category,
          databaseCode: error?.databaseCode,
          steps: error?.steps,
          batch: error?.batch,
          ...(published.code ? { code: published.code } : {}),
          stage: message.action,
          retryable: false,
          health: sessions.health,
        })
      } finally { inflight.delete(message.requestId) }
    })

    await sessions.ensureCatalog()
    credentials.identity = sessions.identity
    input.password = ''
    ready = true
    parentPort.postMessage({
      ok: true,
      ready: true,
      result: { version: sessions.version, database: sessions.database, databases: [], elapsedMs: Date.now() - started, health: 'ready' },
    })
    void (async () => {
      try {
        const pool = sessions.queryPool()
        const schema = credentials.database || sessions.database
        if (!pool || !schema) return
        const leased = await pool.acquire(schema)
        await leased.release()
      } catch { /* prewarm must not delay ready or change health */ }
    })()
  } catch (error) {
    input.password = ''
    parentPort.postMessage({ ok: false, ready: false, error: nativeErrorText(error, '连接失败，请检查连接配置与账号权限。') })
  }
})

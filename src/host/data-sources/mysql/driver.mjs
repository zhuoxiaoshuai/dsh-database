import { DRIVER_TIMEOUTS } from '../../request-timeouts.mjs'
import { mysqlConnectionConfig } from './connection.mjs'
import { formatMysqlValue, mysqlBinaryField } from '../../cell-value.mjs'
import { writeDriverError } from '../sql-write-error.mjs'
import { nativeErrorText } from '../../connect-error.mjs'

const quote = value => '`' + String(value).replaceAll('`', '``') + '`'
const driverErrorFields = ['code', 'errno', 'sqlState', 'errorNum', 'fatal']
const connectionState = new WeakMap()

export function trackMysqlConnection(connection) {
  const core = connection.connection || connection
  if (connectionState.has(core)) return connection
  const state = { closing: false, lost: false, listeners: new Set() }
  connectionState.set(core, state)
  const lost = () => {
    if (state.closing || state.lost) return
    state.lost = true
    for (const listener of state.listeners) listener()
  }
  core.on('error', lost)
  core.on('end', lost)
  return connection
}

function watchConnection(connection, listener) {
  trackMysqlConnection(connection)
  const state = connectionState.get(connection.connection || connection)
  state.listeners.add(listener)
  if (state.lost) queueMicrotask(() => { if (state.listeners.has(listener)) listener() })
  return () => state.listeners.delete(listener)
}

function nativeDriverError(error) {
  const next = new Error(nativeErrorText(error, '数据库没有返回错误说明。'))
  if (error && typeof error === 'object') {
    for (const key of driverErrorFields) if (error[key] != null) next[key] = error[key]
  }
  return next
}

export const sql = Object.freeze({
  id: 'mysql',
  quote,
  bindPlaceholder: () => '?',
  limitClause: (limit, offset = 0) => `LIMIT ${limit} OFFSET ${offset}`,
  equality: (left, placeholder, column) => /char/i.test(column?.type || '') ? `BINARY ${left} <=> BINARY ${placeholder}` : `${left} <=> ${placeholder}`,
  columnTypePattern: /^(?:TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|DECIMAL(?:\(\d{1,2}(?:,\d{1,2})?\))?|NUMERIC(?:\(\d{1,2}(?:,\d{1,2})?\))?|FLOAT|DOUBLE|BOOLEAN|DATE|DATETIME(?:\([0-6]\))?|TIMESTAMP(?:\([0-6]\))?|TIME|CHAR\(\d{1,5}\)|VARCHAR\(\d{1,5}\)|TEXT|MEDIUMTEXT|LONGTEXT|JSON|BLOB)$/,
  identityClause: ' AUTO_INCREMENT',
  inlineColumnComment: true,
  supportsColumnComment: false,
  writableObjectStatement: (schema, name) => ({ sql: 'SELECT TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=? LIMIT 1', params: [schema, name] }),
  maxIdentifierBytes: 64,
  escapeLiteral: (value, sqlMode = '') => sqlMode.split(',').includes('NO_BACKSLASH_ESCAPES') ? value : value.replaceAll('\\', '\\\\'),
  createTableSuffix: ' ENGINE=InnoDB',
  renameTable: (target, next) => `RENAME TABLE ${target} TO ${next}`,
  commentTable: (target, literal) => `ALTER TABLE ${target} COMMENT = ${literal}`,
  columnDefinition: definition => 'COLUMN ' + definition,
  indexName: identifier => identifier,
  dropIndex: (target, identifier) => `DROP INDEX ${identifier} ON ${target}`,
  dropConstraint: (target, identifier, clause) => `ALTER TABLE ${target} DROP ${clause(identifier)}`,
  analyzeTable: target => `ANALYZE TABLE ${target}`,
  bindValue: (_column, value, placeholder) => ({ value, expression: placeholder }),
  filterBind: (_column, value, placeholder) => ({ value, expression: placeholder }),
})

async function openPromise(credentials, options = {}) {
  const mysql = (await import('mysql2/promise')).default
  return trackMysqlConnection(await mysql.createConnection(mysqlConnectionConfig(credentials, options)))
}

async function openCallback(credentials, options = {}) {
  const mysql = (await import('mysql2')).default
  return trackMysqlConnection(mysql.createConnection(mysqlConnectionConfig(credentials, options)))
}

export const mysqlDialect = Object.freeze({
  id: 'mysql',
  sql,
  watchConnection,
  explainMessage: 'EXPLAIN 执行计划 · 只读会话 · 未发送 AI',
  openCatalog(credentials, options = {}) {
    return openPromise(credentials, {
      database: credentials.database || undefined,
      connectTimeout: options.connectTimeout ?? DRIVER_TIMEOUTS.connect,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      decimalNumbers: false,
      ...options,
    })
  },
  openMaintenance(credentials, options = {}) {
    return openPromise(credentials, {
      connectTimeout: DRIVER_TIMEOUTS.maintenanceConnect,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      ...options,
    })
  },
  async openQuery(credentials, options = {}) {
    const db = await openCallback(credentials, {
      database: options.schema || credentials.database || undefined,
      multipleStatements: false,
      connectTimeout: DRIVER_TIMEOUTS.queryConnect,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      dateStrings: true,
      rowsAsArray: options.rowsAsArray !== false,
    })
    try {
      if (options.probe !== false) await db.promise().query({ sql: 'SELECT 1', timeout: DRIVER_TIMEOUTS.connectProbe })
      try { await db.promise().query({ sql: 'SET SESSION MAX_EXECUTION_TIME=' + DRIVER_TIMEOUTS.query, timeout: DRIVER_TIMEOUTS.connectProbe }) } catch (error) { if (error?.fatal || /TIMEOUT|PROTOCOL|ECONN/.test(error?.code || '')) throw error /* compatible servers may not support it */ }
      return db
    } catch (error) { db.destroy(); throw error }
  },
  async probe(connection, credentials) {
    const [[row]] = await connection.query({ sql: 'SELECT VERSION() AS version, DATABASE() AS db', timeout: DRIVER_TIMEOUTS.connectProbe })
    return {
      version: String(row.version || '').slice(0, 120),
      database: String(row.db || '').slice(0, 128),
      identity: JSON.stringify(['plugin', credentials.username]),
    }
  },
  async prepareReadonly(connection, schema) {
    const promise = connection.promise()
    await promise.query('USE ' + quote(schema))
    await promise.query('SET TRANSACTION READ ONLY')
    await promise.beginTransaction()
  },
  async reset(connection) {
    await connection.promise().rollback()
  },
  async runSelect(connection, statement, params, limit, appendRow) {
    return new Promise((resolve, reject) => {
      let columns = [], fields = [], binaryColumns = [], rows = [], bytes = 0, truncated = false, done = false
      const finish = error => {
        if (done) return
        done = true
        try { connection.stream.off('data', wire) } catch { /* ignore */ }
        error ? reject(error) : resolve({ columns, binaryColumns, rows, truncated })
      }
      let wireBytes = 0
      const wire = chunk => {
        wireBytes += chunk.length
        if (wireBytes > 2 * 1024 * 1024) finish(new Error('响应超过传输上限，请选择更少字段或缩小查询范围。'))
      }
      connection.stream.prependListener('data', wire)
      const query = connection.query({ sql: statement, timeout: DRIVER_TIMEOUTS.query, rowsAsArray: true }, params)
      query.on('fields', metadata => {
        fields = metadata
        columns = fields.map(field => field.name)
        binaryColumns = fields.flatMap((field, index) => mysqlBinaryField(field) ? [index] : [])
        if (columns.length > 500 || Buffer.byteLength(JSON.stringify(columns)) > 8192) finish(new Error('结果字段过多或过长。'))
      })
      query.on('result', row => {
        if (done) return
        const next = appendRow(rows, bytes, limit, row.map((value, index) => formatMysqlValue(value, fields[index])))
        rows = next.rows
        bytes = next.bytes
        if (next.truncated) { truncated = true; finish() }
      })
      query.on('error', error => {
        finish(nativeDriverError(error))
      })
      query.on('end', () => finish())
    })
  },
  async executeExplain(connection, statement) {
    try {
      const [rows, fields] = await connection.promise().query({ sql: statement, timeout: DRIVER_TIMEOUTS.query, rowsAsArray: true })
      const result = { columns: fields.map(field => field.name), binaryColumns: fields.flatMap((field, index) => mysqlBinaryField(field) ? [index] : []), rows: rows.map(row => row.map((value, index) => formatMysqlValue(value, fields[index]))) }
      if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw new Error('结果超过 1 MiB，请缩小查询范围。')
      return result
    } catch (error) {
      throw nativeDriverError(error)
    }
  },
  async executeShow(connection, statement) {
    return this.executeExplain(connection, statement)
  },
  async prepareWrite(connection, schema) {
    await connection.promise().query({ sql: 'USE ' + quote(schema), timeout: DRIVER_TIMEOUTS.write })
    await connection.promise().query({ sql: 'SET SESSION innodb_lock_wait_timeout=10, SESSION lock_wait_timeout=10', timeout: DRIVER_TIMEOUTS.write })
  },
  async verifyWritableTargets(connection, targets, assertWritableTargets) {
    return assertWritableTargets('mysql', targets, async (statement, binds) => (await connection.promise().execute({ sql: statement, timeout: DRIVER_TIMEOUTS.write }, binds))[0])
  },
  async executeWrite(connection, statement) {
    try {
      const [result] = await connection.promise().query({ sql: statement, timeout: DRIVER_TIMEOUTS.write })
      return Number(result?.affectedRows ?? 0)
    } catch (error) {
      throw writeDriverError(error, nativeErrorText(error, '数据库没有返回错误说明。'))
    }
  },
  cancel(connection) {
    const state = connection && connectionState.get(connection.connection || connection)
    if (state) state.closing = true
    connection?.destroy?.()
  },
  async destroy(connection) {
    if (!connection) return
    const state = connectionState.get(connection.connection || connection)
    if (state) { state.closing = true; state.listeners.clear() }
    try { connection.destroy() } catch { try { await connection.end() } catch { /* ignore */ } }
  },
})

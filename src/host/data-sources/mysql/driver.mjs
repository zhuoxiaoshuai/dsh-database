import { DRIVER_TIMEOUTS } from '../../request-timeouts.mjs'
import { mysqlConnectionConfig } from './connection.mjs'
import { formatFetchedValue } from '../../cell-value.mjs'
import { rejectDatabaseError } from '../../connect-error.mjs'

const quote = value => '`' + String(value).replaceAll('`', '``') + '`'

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
  return mysql.createConnection(mysqlConnectionConfig(credentials, options))
}

async function openCallback(credentials, options = {}) {
  const mysql = (await import('mysql2')).default
  return mysql.createConnection(mysqlConnectionConfig(credentials, options))
}

export const mysqlDialect = Object.freeze({
  id: 'mysql',
  sql,
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
    if (options.probe !== false) await db.promise().query({ sql: 'SELECT 1', timeout: DRIVER_TIMEOUTS.connectProbe })
    try { await db.promise().query('SET SESSION MAX_EXECUTION_TIME=' + DRIVER_TIMEOUTS.query) } catch { /* compatible servers may not support it */ }
    return db
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
      let columns = [], rows = [], bytes = 0, truncated = false, done = false
      const finish = error => {
        if (done) return
        done = true
        try { connection.stream.off('data', wire) } catch { /* ignore */ }
        error ? reject(error) : resolve({ columns, rows, truncated })
      }
      let wireBytes = 0
      const wire = chunk => {
        wireBytes += chunk.length
        if (wireBytes > 2 * 1024 * 1024) finish(new Error('响应超过传输上限，请选择更少字段或缩小查询范围。'))
      }
      connection.stream.prependListener('data', wire)
      const query = connection.query({ sql: statement, timeout: DRIVER_TIMEOUTS.query, rowsAsArray: true }, params)
      query.on('fields', fields => {
        columns = fields.map(field => field.name)
        if (columns.length > 500 || Buffer.byteLength(JSON.stringify(columns)) > 8192) finish(new Error('结果字段过多或过长。'))
      })
      query.on('result', row => {
        if (done) return
        const next = appendRow(rows, bytes, limit, row.map(value => formatFetchedValue(value, 'mysql')))
        rows = next.rows
        bytes = next.bytes
        if (next.truncated) { truncated = true; finish() }
      })
      query.on('error', error => {
        finish(new Error(rejectDatabaseError(error)))
      })
      query.on('end', () => finish())
    })
  },
  async executeExplain(connection, statement) {
    try {
      const [rows, fields] = await connection.promise().query({ sql: statement, timeout: DRIVER_TIMEOUTS.query, rowsAsArray: true })
      return { columns: fields.map(field => field.name), rows: rows.map(row => row.map(value => value === null ? null : String(value))) }
    } catch (error) {
      throw new Error(rejectDatabaseError(error))
    }
  },
  async executeShow(connection, statement) {
    return this.executeExplain(connection, statement)
  },
  async prepareWrite(connection, schema) {
    await connection.promise().query('USE ' + quote(schema))
    await connection.promise().query('SET SESSION innodb_lock_wait_timeout=10')
  },
  async verifyWritableTargets(connection, targets, assertWritableTargets) {
    return assertWritableTargets('mysql', targets, async (statement, binds) => (await connection.promise().execute(statement, binds))[0])
  },
  async executeWrite(connection, statement) {
    try {
      const [result] = await connection.promise().query({ sql: statement, timeout: DRIVER_TIMEOUTS.write })
      return Number(result?.affectedRows ?? 0)
    } catch (error) {
      throw new Error(rejectDatabaseError(error))
    }
  },
  cancel(connection) {
    connection?.destroy?.()
  },
  async destroy(connection) {
    if (!connection) return
    try { connection.destroy() } catch { try { await connection.end() } catch { /* ignore */ } }
  },
})

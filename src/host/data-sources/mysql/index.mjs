import { mysqlDialect } from './driver.mjs'
import * as connection from './connection.mjs'
import * as catalog from './catalog.mjs'
import * as policy from './policy.mjs'
import * as maintenance from './maintenance.mjs'
import { mysqlRuntime } from './runtime.mjs'

const isTimeout = error => /timeout|timed out|ETIMEDOUT|PROTOCOL_SEQUENCE_TIMEOUT/i.test(`${error?.code || ''} ${error?.message || ''}`)
const isFatalQuery = (error, flags = {}) => {
  if (flags.aborted || flags.truncated || flags.cancelled || error?.cancelled) return true
  return /PROTOCOL|ECONNRESET|EPIPE|ECONNREFUSED|not connected|closed|Connection lost/i.test(`${error?.code || ''} ${error?.message || error || ''}`)
}
const isFatalCatalog = error => {
  if (error?.cancelled) return false
  const text = `${error?.code || ''} ${error?.message || error || ''}`
  if (/ER_ACCESS|ER_DBACCESS|ER_TABLEACCESS|ER_BAD_DB|ER_NO_SUCH|ER_PARSE|无权|不存在|语法|已取消/i.test(text)) return false
  return /ECONNRESET|EPIPE|ECONNREFUSED|PROTOCOL_CONNECTION_LOST|PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR|not connected|socket closed|Connection lost/i.test(text)
}

export const mysqlProvider = Object.freeze({
  id: 'mysql', family: 'sql',
  runtime: mysqlRuntime,
  capabilities: Object.freeze({ showIndex: true, showStatement: true, columnComment: false }),
  connection,
  driver: mysqlDialect,
  catalog,
  policy,
  maintenance,
  recovery: Object.freeze({
    discardOnCancel: true,
    discardOnTimeout: isTimeout,
    isFatalCatalog,
    isFatalQuery,
    shouldRetryReadonly: (error, flags = {}) => !flags.aborted && !flags.cancelled && !error?.cancelled && !isTimeout(error) && isFatalQuery(error),
  }),
})

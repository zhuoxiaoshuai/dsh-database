import { oracleDialect } from './driver.mjs'
import * as connection from './connection.mjs'
import * as catalog from './catalog.mjs'
import * as policy from './policy.mjs'
import * as maintenance from './maintenance.mjs'
import { oracleRuntime } from './runtime.mjs'

const isTimeout = error => /timeout|timed out|ETIMEDOUT|DPI-1067|ORA-12170/i.test(`${error?.code || ''} ${error?.message || ''}`)
const isFatalQuery = (error, flags = {}) => {
  if (flags.aborted || flags.truncated || flags.cancelled || error?.cancelled) return true
  return /ECONNRESET|EPIPE|ECONNREFUSED|not connected|closed|Connection lost|NJS-|DPI-|ORA-03113|ORA-03114|ORA-12541|ORA-12170|实例或账号/i.test(`${error?.code || ''} ${error?.message || error || ''}`)
}
const isFatalCatalog = error => {
  if (error?.cancelled) return false
  const text = `${error?.code || ''} ${error?.message || error || ''}`
  if (/ORA-00942|ORA-01031|无权|不存在|语法|已取消/i.test(text)) return false
  return /NJS-003|NJS-500|DPI-|ORA-03113|ORA-03114|ORA-12541|ORA-12170|ECONNRESET|EPIPE|ECONNREFUSED/i.test(text)
}

export const oracleProvider = Object.freeze({
  id: 'oracle', family: 'sql',
  runtime: oracleRuntime,
  capabilities: Object.freeze({ showIndex: false, showStatement: false, columnComment: true }),
  connection,
  driver: oracleDialect,
  catalog,
  policy,
  maintenance,
  recovery: Object.freeze({
    discardOnCancel: false,
    discardOnTimeout: () => false,
    isFatalCatalog,
    isFatalQuery,
    shouldRetryReadonly: (error, flags = {}) => !flags.aborted && !flags.cancelled && !error?.cancelled && !isTimeout(error) && isFatalQuery(error),
  }),
})

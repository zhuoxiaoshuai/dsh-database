/** Native driver or broker text. No redaction, wrappers, or whitespace folding. */

function trimmedField(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Message, then sqlMessage, then code, then cause. Strings pass through unchanged.
 * @param {unknown} error
 * @param {string} [fallback]
 */
export function nativeErrorText(error, fallback = '') {
  if (typeof error === 'string') return error || fallback
  if (error && typeof error === 'object') {
    const message = trimmedField(error.message)
    if (message) return message
    const sqlMessage = trimmedField(error.sqlMessage)
    if (sqlMessage) return sqlMessage
    const code = trimmedField(error.code)
    if (code) return code
    if (error.cause != null && error.cause !== error) {
      const caused = nativeErrorText(error.cause, '')
      if (caused) return caused
    }
  }
  return fallback
}

const driverErrorFields = ['code', 'errno', 'sqlState', 'errorNum', 'fatal']

/**
 * Fresh Error with the native message and the driver fields copied in order.
 * @param {unknown} error
 */
export function nativeDriverError(error) {
  const next = new Error(nativeErrorText(error, '数据库没有返回错误说明。'))
  if (error && typeof error === 'object') {
    for (const key of driverErrorFields) if (error[key] != null) next[key] = error[key]
  }
  return next
}

/** Handshake errors: keep a short class, always append the sanitized driver message. */

export function redactDatabaseSecrets(value) {
  return String(value)
    .replace(/(password|passwd|pwd)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/protectedPassword[^,}]*/gi, 'protectedPassword=***')
    .replace(/\(DESCRIPTION[\s\S]*?\)\)/gi, '(DESCRIPTION=***)')
}

/**
 * @param {unknown} value
 * @param {{ maxLength?: number, truncateBeforeRedaction?: boolean, normalizeWhitespace?: boolean }} [options]
 */
export function sanitizeDatabaseError(value, { maxLength, truncateBeforeRedaction = true, normalizeWhitespace = true } = {}) {
  let text = String(value || '')
  if (normalizeWhitespace) text = text.replace(/\s+/g, ' ').trim()
  if (maxLength && truncateBeforeRedaction) text = text.slice(0, maxLength)
  text = redactDatabaseSecrets(text)
  return maxLength && !truncateBeforeRedaction ? text.slice(0, maxLength) : text
}

export function databaseErrorDetail(error, options = {}) {
  const parts = []
  const append = value => {
    const text = String(value || '').trim()
    if (text && !parts.some(part => part.includes(text) || text.includes(part))) parts.push(text)
  }
  append(error?.sqlMessage)
  append(error?.message)
  append(error?.code)
  if (Number.isInteger(error?.errno)) append(`errno ${error.errno}`)
  if (error?.sqlState) append(`SQLSTATE ${error.sqlState}`)
  if (Number.isInteger(error?.errorNum)) append(`ORA-${String(error.errorNum).padStart(5, '0')}`)
  if (Number.isInteger(error?.offset) && error.offset > 0) append(`位置 ${error.offset}`)
  if (!parts.length && error?.cause && error.cause !== error) return databaseErrorDetail(error.cause, options)
  return sanitizeDatabaseError(parts.join(' · '), options)
}

export function rejectDatabaseError(error, options = {}) {
  const message = databaseErrorDetail(error, { maxLength: 1000, normalizeWhitespace: false, ...options })
  const detail = message.replace(/^数据库拒绝查询：/, '').trim()
  return detail || '数据库没有返回错误说明。'
}

export function sanitizeConnectDetail(error) {
  return databaseErrorDetail(error, { maxLength: 400 })
}

export function safeConnectError(error) {
  const code = String(error?.code || '')
  const detail = sanitizeConnectDetail(error)
  const withDetail = hint => (detail && !hint.includes(detail) ? `${hint}（${detail}）` : hint)
  if (code === 'EACCES' || code === 'EPERM') return withDetail('当前工作台进程没有访问该数据库地址的网络权限，请检查启动环境的沙箱或防火墙限制；这不是密码错误。')
  if (['ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR'].includes(code) || [1017, 28000, 28001].includes(error?.errorNum)) {
    return withDetail('认证失败或账号受限，请检查用户名、密码和访问权限。')
  }
  if (code === 'ER_BAD_DB_ERROR') return withDetail('数据库不存在或不可访问，可清空数据库名称后测试服务器连接。')
  if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(code)) {
    return withDetail('无法连接服务器，请检查主机、端口及网络。')
  }
  if (code.startsWith('NJS-') || code.startsWith('ORA-') || /^ORA-\d+/i.test(detail)) {
    return withDetail('Oracle 连接失败，请检查账号、Service Name / SID、网络及驱动兼容性。')
  }
  return detail ? `连接失败：${detail}` : '连接失败，请检查连接配置与账号权限。'
}

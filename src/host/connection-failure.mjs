/** Vendor codes stay in workers. Host only schedules recoverable transport failures. */
export function connectionFailure(error, depth = 0) {
  if (['network','authentication','configuration','permission','operation','cancelled','internal'].includes(error?.category)) return error.category
  if (error?.cancelled || error?.code === 'request_cancelled') return 'cancelled'
  const text = `${error?.code || ''} ${error?.name || ''} ${error?.message || error || ''}`
  if (/ACL|NOPERM|permission|Authorization|权限|无权|ORA-01031|ER_TABLEACCESS_DENIED/i.test(text)) return 'permission'
  if (/AUTHENTICATION|SASL|WRONGPASS|NOAUTH|ORA-01017|ORA-2800[01]|ER_ACCESS_DENIED|密码|登录失败|认证/i.test(text)) return 'authentication'
  if (/CERT|TLS|SSL|证书|配置无效|地址无效|请输入|需要有效|身份发生变化/i.test(text)) return 'configuration'
  if (/ECONN|EPIPE|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|PROTOCOL_CONNECTION_LOST|ORA-031|ORA-125|NJS-500|NJS-501|DPI-10[18]0|Connection|Socket|RequestTimeout|HTTP\s+5\d\d|timeout|timed out|超时|网络|连接已断|连接已关闭/i.test(text)) return 'network'
  if (depth < 4 && error?.cause && error.cause !== error) return connectionFailure(error.cause, depth + 1)
  return 'operation'
}
export function recoveryDelay(attempt, random = Math.random) {
  const delays = [500, 1000, 2000, 5000, 15000, 30000, 60000]
  return Math.round(delays[Math.min(Math.max(0, attempt), delays.length - 1)] * (0.8 + random() * 0.4))
}

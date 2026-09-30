// Host 外层 deadline 略长于驱动超时，避免统一落到连接层的 30 秒错误。
export const HOST_TIMEOUTS = Object.freeze({
  connect: 15_000,
  connectTest: 10_000,
  catalog: 15_000,
  query: 32_000,
  maintenance: 45_000,
  queue: 30_000,
  redisKeySuggest: 5_000,
})

export const DRIVER_TIMEOUTS = Object.freeze({
  connect: 10_000,
  connectProbe: 5_000,
  connectTransportSec: 8,
  metadata: 10_000,
  queryConnect: 5_000,
  query: 25_000,
  write: 30_000,
  maintenanceConnect: 5_000,
  maintenanceCall: 10_000,
})

export function hostDeadlineFor(action) {
  if (action === 'connect' || action === 'reconnect' || action === 'revive') return HOST_TIMEOUTS.connect
  if (action === 'connectTest') return HOST_TIMEOUTS.connectTest
  if (action === 'catalog') return HOST_TIMEOUTS.catalog
  if (action === 'redis-key-suggest') return HOST_TIMEOUTS.redisKeySuggest
  if (action === 'maintenance') return HOST_TIMEOUTS.maintenance
  if (action === 'query' || action === 'manual-query' || action === 'browse') return HOST_TIMEOUTS.query
  return HOST_TIMEOUTS.query
}

export function hostTimeoutMessage(action, ms = hostDeadlineFor(action)) {
  const seconds = Math.round(ms / 1000)
  if (action === 'maintenance') return '维护超时，结果未知；连接已关闭。请重新连接并核验实际状态，不要直接重试。'
  if (action === 'catalog') return `读取元数据超过 ${seconds} 秒，已取消本次请求；共享连接仍可用。`
  if (action === 'redis-key-suggest') return `Key 补全查询超过 ${seconds} 秒，已取消本次请求。`
  return `查询超过 ${seconds} 秒，已超时；共享连接仍可用。`
}

export function connectTimeoutMessage(testOnly) {
  const seconds = Math.round((testOnly ? HOST_TIMEOUTS.connectTest : HOST_TIMEOUTS.connect) / 1000)
  return `连接超时（${seconds} 秒），已终止本次连接，请检查网络及数据库地址。`
}

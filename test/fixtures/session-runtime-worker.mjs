import { parentPort } from 'node:worker_threads'

const failReconnect = new URL(import.meta.url).searchParams.get('failReconnect') === '1'
let ready = false
let catalogFatal = 0
const querySql = []
parentPort.on('message', message => {
  if (message.input && !message.requestId) {
    if (message.input.fail) {
      parentPort.postMessage({ ok: false, ready: false, error: 'fixture failure' })
      return
    }
    const delay = message.input.slowReady ? 30 : 0
    setTimeout(() => {
      ready = true
      parentPort.postMessage({
        ok: true,
        ready: true,
        result: { version: 'session-runtime-1', database: message.input.database, elapsedMs: delay, databases: [], health: 'ready' },
      })
    }, delay)
    return
  }
  if (message.cancel && message.requestId) {
    parentPort.postMessage({ requestId: message.requestId, cancelled: true, error: '读取已取消。' })
    return
  }
  if (!message.requestId) return
  if (!ready) {
    parentPort.postMessage({ requestId: message.requestId, error: '连接尚未就绪。', stage: 'connect', retryable: false })
    return
  }
  if (message.action === 'reconnect') {
    if (failReconnect) {
      parentPort.postMessage({ requestId: message.requestId, error: '无法建立 CatalogSession。', health: 'offline' })
      return
    }
    parentPort.postMessage({ requestId: message.requestId, result: { version: 'session-runtime-1', database: 'app', elapsedMs: 1 }, health: 'ready' })
    return
  }
  if (message.action === 'query' || message.action === 'manual-query') {
    querySql.push(message.input?.sql)
    parentPort.postMessage({
      requestId: message.requestId,
      result: { columns: ['n'], rows: [[String(querySql.length)]], truncated: false, elapsedMs: 1, replayed: false, queryCount: querySql.length, trustedAuthorization: !!message.authorized },
    })
    return
  }
  if (message.action === 'catalog') {
    if (message.input?.kind === 'tables' && message.input?.schema === 'denied') {
      parentPort.postMessage({ requestId: message.requestId, error: '无权读取此库。', retryable: false, stage: 'catalog' })
      return
    }
    if (message.input?.kind === 'schemas' && message.input?.refresh) {
      catalogFatal += 1
      if (catalogFatal === 1) {
        parentPort.postMessage({ requestId: message.requestId, error: 'PROTOCOL_CONNECTION_LOST', retryable: false, stage: 'catalog' })
        return
      }
      if (catalogFatal >= 3 && message.input?.twice) {
        parentPort.postMessage({ requestId: message.requestId, error: 'PROTOCOL_CONNECTION_LOST', health: 'degraded', stage: 'catalog' })
        return
      }
    }
    parentPort.postMessage({
      requestId: message.requestId,
      result: { items: [{ name: 'app' }], more: false, collectedAt: new Date().toISOString(), source: 'fixture' },
      health: 'ready',
    })
  }
})

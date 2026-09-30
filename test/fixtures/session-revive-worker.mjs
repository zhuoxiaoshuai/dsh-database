import { parentPort } from 'node:worker_threads'

const failRevive = new URL(import.meta.url).searchParams.get('failRevive') === '1'
let ready = false
let database = 'app'
parentPort.on('message', message => {
  if (message.input && !message.requestId) {
    database = String(message.input.database || 'app')
    ready = true
    parentPort.postMessage({
      ok: true,
      ready: true,
      result: { version: 'session-revive-1', database, elapsedMs: 1, databases: [], health: 'ready' },
    })
    if (database !== 'other') {
      setTimeout(() => { parentPort.postMessage({ health: 'degraded' }) }, 50).unref()
    }
    return
  }
  if (!message.requestId) return
  if (!ready) {
    parentPort.postMessage({ requestId: message.requestId, error: '连接尚未就绪。', stage: 'connect', retryable: false })
    return
  }
  if (message.action === 'reconnect') {
    parentPort.postMessage({
      requestId: message.requestId,
      result: { version: 'session-reconnected', database, elapsedMs: 1, health: 'ready' },
    })
    return
  }
  if (message.action === 'revive') {
    if (failRevive && database !== 'other') {
      parentPort.postMessage({ requestId: message.requestId, error: '无法恢复 CatalogSession。', health: 'offline' })
      return
    }
    parentPort.postMessage({
      requestId: message.requestId,
      result: { version: 'session-revive-1', database, elapsedMs: 1 },
      health: 'ready',
    })
    return
  }
  parentPort.postMessage({
    requestId: message.requestId,
    result: { items: [], collectedAt: new Date().toISOString(), source: 'fixture' },
    health: 'ready',
  })
})

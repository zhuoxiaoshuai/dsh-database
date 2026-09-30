import { parentPort } from 'node:worker_threads'

parentPort.on('message', message => {
  if (message.input && !message.requestId) {
    if (message.input.password === 'wrong') {
      parentPort.postMessage({ error: '无法建立 CatalogSession。' })
      return
    }
    parentPort.postMessage({
      ok: true,
      ready: true,
      result: { version: 'session-runtime-1', database: message.input.database, elapsedMs: 1, databases: [], health: 'ready' },
    })
    return
  }
  if (message.action === 'reconnect') {
    parentPort.postMessage({ requestId: message.requestId, error: '无法建立 CatalogSession。', health: 'offline' })
    return
  }
  if (message.requestId) {
    parentPort.postMessage({ requestId: message.requestId, result: { items: [{ name: 'app' }], more: false, collectedAt: new Date().toISOString(), source: 'fixture' } })
  }
})

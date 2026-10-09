import { parentPort, workerData } from 'node:worker_threads'
import { appendFileSync } from 'node:fs'
const marker = workerData.marker
const blockedReplies = []
parentPort.on('message', message => {
  if (message.fixtureRelease) { for (const reply of blockedReplies.splice(0)) reply(); return }
  if (message.cancel) return
  if (!message.requestId || message.action === 'connect') {
    parentPort.postMessage({ ok: true, ready: true, result: { version: 'fixture', database: message.input?.database || '0', health: 'ready' } })
    return
  }
  appendFileSync(marker, JSON.stringify({ action: message.action, input: message.input }) + '\n')
  if (message.action === 'redis-scan' || message.action === 'redis-key') {
    const selector = message.input?.match || message.input?.key
    if (selector === 'fixture:hang') return
    if (selector === 'fixture:exit') { setTimeout(() => process.exit(1), 10); return }
    if (selector === 'fixture:error-private') { parentPort.postMessage({ requestId: message.requestId, error: 'NOPERM fixture:error-private SECRET_PAYLOAD' }); return }
    const result = message.action === 'redis-scan' ? { cursor: '0', keys: ['fixture:key'] }
      : { keyType: 'string', ttl: -1, value: { result: { type: 'string', value: 'SECRET_PAYLOAD' } } }
    setTimeout(() => parentPort.postMessage({ requestId: message.requestId, result }), selector === 'fixture:delay' ? 300 : 0)
    return
  }
  if (message.input?.args?.[0] === 'HANG') return
  if (message.input?.args?.[0] === 'EXIT') { setTimeout(() => process.exit(1), 10); return }
  if (message.input?.args?.[0] === 'TIMEOUT') { setTimeout(() => parentPort.postMessage({ requestId: message.requestId, error: 'Redis 操作超时，执行结果未知，请核验。' }), 10); return }
  const blocked = message.input?.args?.[0] === 'BLOCK'
  if (blocked && workerData.blockUntilReleased) {
    blockedReplies.push(() => parentPort.postMessage({ requestId: message.requestId, result: { result: { type: 'string', value: 'OK' } } }))
    return
  }
  setTimeout(() => parentPort.postMessage({ requestId: message.requestId, result: { result: { type: 'string', value: 'OK' } } }), blocked ? 300 : 0)
})

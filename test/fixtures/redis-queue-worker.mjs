import { parentPort, workerData } from 'node:worker_threads'
import { appendFileSync } from 'node:fs'
const marker = workerData.marker
parentPort.on('message', message => {
  if (message.cancel) return
  if (!message.requestId || message.action === 'connect') {
    parentPort.postMessage({ ok: true, ready: true, result: { version: 'fixture', database: '0', health: 'ready' } })
    return
  }
  appendFileSync(marker, JSON.stringify({ action: message.action, input: message.input }) + '\n')
  const blocked = message.input?.args?.[0] === 'BLOCK'
  setTimeout(() => parentPort.postMessage({ requestId: message.requestId, result: { result: { type: 'string', value: 'OK' } } }), blocked ? 300 : 0)
})

import { parentPort, workerData } from 'node:worker_threads'
import { appendFileSync } from 'node:fs'
const held = new Map()
parentPort.on('message', message => {
  if (message.fixtureRelease) { for (const done of held.values()) done(); held.clear(); return }
  if (message.cancel) { held.delete(message.requestId); parentPort.postMessage({ requestId: message.requestId, cancelled: true }); return }
  if (!message.requestId) { parentPort.postMessage({ ok: true, ready: true, result: { version: 'fixture', database: 'app', health: 'ready' } }); return }
  appendFileSync(workerData.marker, JSON.stringify({ action: message.action, input: message.input }) + '\n')
  const input = message.input
  const send = () => {
    if (input.search === 'ERROR') { parentPort.postMessage({ requestId: message.requestId, error: 'fixture catalog error' }); return }
    if (input.search === 'TIMEOUT') { parentPort.postMessage({ requestId: message.requestId, error: '查询超过 30 秒，已超时。' }); return }
    if (input.search === 'EXIT') { process.exit(1); return }
    const result = input.search === 'ACL' ? { status: 'unavailable', reason: '无权读取目录' }
      : input.kind === 'table' ? { columns: [{ name: 'id' }], indexes: { status: 'unavailable', reason: '无权读取索引' }, constraints: { status: 'ok', items: [] } }
      : input.kind === 'indexes' ? { indexes: { status: 'unavailable', reason: '无权读取索引' } }
      : { items: [{ name: input.kind === 'schemas' ? 'app' : 'records', tables: 1, views: 0 }], more: false, source: 'live', collectedAt: 'fixture' }
    parentPort.postMessage({ requestId: message.requestId, result })
  }
  if (input.search === 'BLOCK') held.set(message.requestId, send)
  else send()
})

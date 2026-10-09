import { parentPort, workerData } from 'node:worker_threads'
import { appendFileSync } from 'node:fs'
const blocked = []
parentPort.on('message', message => {
  if (message.fixtureRelease) { for (const reply of blocked.splice(0)) reply(); return }
  if (message.cancel) return
  if (!message.requestId) { parentPort.postMessage({ ok: true, ready: true, result: { version: 'fixture', database: '', health: 'ready' } }); return }
  appendFileSync(workerData.marker, JSON.stringify({ action: message.action, input: message.input }) + '\n')
  if (message.action === 'kafka-produce' && message.input?.text?.includes('HANG_RECEIPT')) return
  const reply = () => parentPort.postMessage({ requestId: message.requestId,
    result: message.action === 'kafka-produce' ? { kind: 'produce', topic: 'demo', partition: 0, baseOffset: '42', acknowledged: true, valueBytes: 5 }
      : { kind: 'topics', topics: ['demo'], messages: [{ value: 'PRIVATE_PAYLOAD' }] }, health: 'ready' })
  if (message.input?.text === 'DESCRIBE "BLOCK"') blocked.push(reply)
  else setTimeout(reply, 10)
})

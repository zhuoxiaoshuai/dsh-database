import { parentPort } from 'node:worker_threads'
parentPort.on('message', message => {
  if (!message.requestId) { parentPort.postMessage({ ready: true, result: { version: 'test-only', database: '', health: 'ready' } }); return }
  if (message.cancel) return
  if (message.action !== 'mock-read') { parentPort.postMessage({ requestId: message.requestId, error: 'Unsupported fixture action' }); return }
  parentPort.postMessage({ requestId: message.requestId, result: { kind: 'mock', value: '模拟读取完成', received: message.input.text } })
})

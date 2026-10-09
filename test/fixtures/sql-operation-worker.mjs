import { parentPort, workerData } from 'node:worker_threads'
import { appendFileSync } from 'node:fs'

const blocked = new Map()
const reply = (requestId, result) => parentPort.postMessage({ requestId, result })
parentPort.on('message', message => {
  if (message.fixtureRelease) {
    for (const done of blocked.values()) done()
    blocked.clear()
    return
  }
  if (message.cancel) {
    blocked.delete(message.requestId)
    parentPort.postMessage({ requestId: message.requestId, cancelled: true })
    return
  }
  if (!message.requestId) {
    parentPort.postMessage({ ok: true, ready: true, result: { version: 'fixture', database: message.input?.database || 'app', health: 'ready' } })
    return
  }
  appendFileSync(workerData.marker, JSON.stringify({ action: message.action, input: message.input, authorized: message.authorized, lane: message.lane }) + '\n')
  if (message.action === 'maintenance') {
    blocked.set(message.requestId, () => reply(message.requestId, { status: 'ok' }))
    return
  }
  if (message.action === 'catalog') {
    reply(message.requestId, { items: [{ name: 'app' }, { name: 'other' }] })
    return
  }
  if (message.action === 'query' || message.action === 'manual-query') {
    const sql = message.input?.sql || ''
    if (sql.includes('FIXTURE_PROGRESS')) {
      const steps = [{ index: 0, sql: 'UPDATE records SET id=2', status: 'succeeded', affectedRows: 1 }, { index: 1, sql: 'UPDATE records SET id=3', status: 'unknown' }]
      const batch = [{ columns: [], rows: [], elapsedMs: 1, truncated: false, affectedRows: 1, stepIndex: 0 }]
      parentPort.postMessage({ requestId: message.requestId, sqlProgress: { steps, batch } })
      setTimeout(() => parentPort.postMessage({ requestId: message.requestId, error: 'receipt lost', effect: 'unknown', phase: 'execute', category: 'transport-or-interruption', databaseCode: 'ECONNRESET', steps, batch }), 30)
      return
    }
    if (sql.includes('FIXTURE_EXIT')) { process.exit(1); return }
    if (sql.includes('FIXTURE_ERROR')) { parentPort.postMessage({ requestId: message.requestId, error: 'fixture database error' }); return }
    if (sql.includes('FIXTURE_TIMEOUT')) { parentPort.postMessage({ requestId: message.requestId, error: '查询超过 30 秒，已超时。' }); return }
    const result = { columns: ['id'], rows: [['1']], elapsedMs: 1, truncated: false,
      ...(/^\s*(INSERT|UPDATE|DELETE)/i.test(sql) ? { affectedRows: 1, message: '影响 1 行。' } : {}) }
    if (sql.includes('FIXTURE_BLOCK')) blocked.set(message.requestId, () => reply(message.requestId, result))
    else reply(message.requestId, result)
    return
  }
  reply(message.requestId, { version: 'fixture', database: 'app', health: 'ready' })
})

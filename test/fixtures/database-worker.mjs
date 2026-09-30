import { appendFileSync } from 'node:fs'
import { parentPort } from 'node:worker_threads'

const marker = new URL(import.meta.url).searchParams.get('marker')
const heartbeat = marker ? setInterval(() => appendFileSync(marker, 'alive\n'), 10) : undefined
heartbeat?.unref()

const inflight = new Map()
const inserted = new Set(['1'])
let catalogBusy = false

function statementResult(sql) {
  const parts = String(sql || '').split(';').map(part => part.trim()).filter(Boolean)
  const apply = part => {
    const created = part.match(/INSERT INTO records \(id\) VALUES \((\d+)\)/i)
    if (created) inserted.add(created[1])
    if (/^DELETE\s+FROM\s+records\b/i.test(part)) inserted.clear()
  }
  if (parts.length > 1) {
    const bad = parts.findIndex(part => /missing_column/i.test(part))
    if (bad >= 0) {
      parts.slice(0, bad).forEach(apply)
      return { error: 'Unknown column missing_column' }
    }
    parts.forEach(apply)
    const batch = parts.map(part => {
      const literal = part.match(/SELECT\s+(\d+)/i)
      return { columns: literal ? ['n'] : ['id', 'note'], rows: [[literal ? literal[1] : '1', ...(literal ? [] : ['secret-value'])]], truncated: false, elapsedMs: 1, sql: part }
    })
    const last = batch.at(-1)
    return { result: { ...last, rows: last.rows.map(row => row.slice(0, last.columns.length)), batch, elapsedMs: parts.length, truncated: false } }
  }
  apply(parts[0] || '')
  const id = String(sql || '').match(/WHERE\s+id\s*=\s*(\d+)/i)?.[1]
  if (id) return { result: { columns: ['id', 'note'], rows: inserted.has(id) ? [[id, 'secret-value']] : [], truncated: false, elapsedMs: 1 } }
  return undefined
}
parentPort.on('message', message => {
  if (message.cancel && message.requestId) {
    const timer = inflight.get(message.requestId)
    if (timer) clearTimeout(timer)
    inflight.delete(message.requestId)
    catalogBusy = false
    parentPort.postMessage({ requestId: message.requestId, cancelled: true, error: '读取已取消。' })
    return
  }
  if (message.input?.fail) {
    parentPort.postMessage({ ok: false, ready: false, error: 'fixture failure' })
    return
  }
  if (message.action === 'reconnect') {
    parentPort.postMessage({
      requestId: message.requestId,
      result: { version: 'fixture-db-1', database: message.input?.database || 'app', elapsedMs: 1, health: 'ready' },
    })
    return
  }
  if (message.action === 'revive') {
    parentPort.postMessage({
      requestId: message.requestId,
      result: { version: 'fixture-db-1', database: 'app', elapsedMs: 1, health: 'ready' },
    })
    return
  }
  if (message.action === 'maintenance') {
    const timer = setTimeout(() => {
      inflight.delete(message.requestId)
      parentPort.postMessage({
        requestId: message.requestId,
        result: { status: 'ok', collectedAt: new Date().toISOString(), source: 'fixture' },
      })
    }, 100)
    inflight.set(message.requestId, timer)
    return
  }
  if (message.requestId) {
    if (message.action === 'query' || message.action === 'manual-query') {
      const structuredCode = {
        STRUCTURED_BUSY: 'connection_busy',
        STRUCTURED_CANCELLED: 'request_cancelled',
        STRUCTURED_TIMEOUT: 'connection_timeout',
        STRUCTURED_OFFLINE: 'connection_offline',
      }[String(message.input?.sql || '').match(/STRUCTURED_[A-Z]+/)?.[0]]
      if (structuredCode) {
        parentPort.postMessage({
          requestId: message.requestId,
          error: '文案不包含分类关键字',
          code: structuredCode,
          retryable: true,
        })
        return
      }
      const scripted = statementResult(message.input?.sql)
      if (scripted?.error) {
        parentPort.postMessage({ requestId: message.requestId, error: scripted.error, retryable: false })
        return
      }
      const delay = /SLEEP_TEST/.test(String(message.input?.sql || '')) ? 2000 : 0
      const timer = setTimeout(() => {
        inflight.delete(message.requestId)
        parentPort.postMessage({
          requestId: message.requestId,
          result: scripted?.result || {
            columns: ['id', 'note'],
            rows: [['1', 'secret-value']],
            truncated: false,
            elapsedMs: 1,
            collectedAt: new Date().toISOString(),
            source: 'fixture',
            trustedAuthorization: !!message.authorized,
          },
        })
      }, delay)
      inflight.set(message.requestId, timer)
      return
    }
    if (message.input?.kind === 'indexes') {
      parentPort.postMessage({
        requestId: message.requestId,
        result: {
          indexes: { status: 'unavailable', reason: '当前账号无权读取索引。' },
          collectedAt: new Date().toISOString(),
          source: 'fixture',
        },
      })
      return
    }
    if (message.input?.kind === 'table') {
      parentPort.postMessage({
        requestId: message.requestId,
        result: {
          columns: [{ name: 'id', type: 'bigint' }, { name: 'note', type: 'varchar' }],
          indexes: { status: 'unavailable', reason: '当前账号无权读取索引。' },
          constraints: { status: 'actual', values: [] },
          collectedAt: new Date().toISOString(),
          source: 'fixture',
        },
      })
      return
    }
    if (catalogBusy) {
      parentPort.postMessage({ requestId: message.requestId, error: '此连接正在处理请求，请稍后再试。' })
      return
    }
    catalogBusy = true
    const delay = message.input?.kind === 'schemas' ? 80 : 0
    const timer = setTimeout(() => {
      catalogBusy = false
      inflight.delete(message.requestId)
      parentPort.postMessage({ requestId: message.requestId, result: { items: [], collectedAt: new Date().toISOString(), source: 'fixture' } })
    }, delay)
    inflight.set(message.requestId, timer)
    return
  }
  parentPort.postMessage({ ok: true, ready: true, result: { version: 'fixture-db-1', database: message.input.database, elapsedMs: 1, databases: [], health: 'ready' } })
})


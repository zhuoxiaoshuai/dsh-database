import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DRIVER_TIMEOUTS, HOST_TIMEOUTS, connectTimeoutMessage, hostDeadlineFor, hostTimeoutMessage } from '../src/host/request-timeouts.mjs'

test('host deadlines cover probe/catalog/query stages separately', () => {
  assert.equal(hostDeadlineFor('catalog'), HOST_TIMEOUTS.catalog)
  assert.equal(hostDeadlineFor('query'), HOST_TIMEOUTS.query)
  assert.equal(hostDeadlineFor('manual-query'), HOST_TIMEOUTS.query)
  assert.equal(hostDeadlineFor('browse'), HOST_TIMEOUTS.query)
  assert.equal(hostDeadlineFor('maintenance'), HOST_TIMEOUTS.maintenance)
  assert.equal(hostDeadlineFor('connect'), HOST_TIMEOUTS.connect)
  assert.equal(hostDeadlineFor('reconnect'), HOST_TIMEOUTS.connect)
  assert.equal(hostDeadlineFor('revive'), HOST_TIMEOUTS.connect)
  assert.ok(HOST_TIMEOUTS.catalog < HOST_TIMEOUTS.query)
  assert.ok(HOST_TIMEOUTS.query < HOST_TIMEOUTS.maintenance)
  assert.ok(DRIVER_TIMEOUTS.metadata < HOST_TIMEOUTS.catalog)
  assert.ok(DRIVER_TIMEOUTS.query < HOST_TIMEOUTS.query)
  assert.ok(DRIVER_TIMEOUTS.write < HOST_TIMEOUTS.query)
  assert.ok(DRIVER_TIMEOUTS.write > DRIVER_TIMEOUTS.query)
  assert.ok(DRIVER_TIMEOUTS.connectProbe < HOST_TIMEOUTS.connectTest)
  assert.ok(DRIVER_TIMEOUTS.connect < HOST_TIMEOUTS.connect)
  assert.match(hostTimeoutMessage('catalog'), /元数据/)
  assert.match(hostTimeoutMessage('query'), /查询/)
  assert.match(hostTimeoutMessage('query'), /已超时/)
  assert.equal(/已取消/.test(hostTimeoutMessage('query')), false)
  assert.match(hostTimeoutMessage('maintenance'), /维护超时/)
  assert.match(connectTimeoutMessage(true), /10 秒/)
  assert.match(connectTimeoutMessage(false), /15 秒/)
  assert.notEqual(hostTimeoutMessage('catalog'), hostTimeoutMessage('query'))
  assert.notEqual(hostTimeoutMessage('query'), hostTimeoutMessage('maintenance'))
})

test('worker ready handshake does not enumerate databases', () => {
  const worker = readFileSync(new URL('../src/host/connection-worker.mjs', import.meta.url), 'utf8')
  const catalog = readFileSync(new URL('../src/host/data-sources/mysql/catalog.mjs', import.meta.url), 'utf8')
  assert.equal(worker.includes('SHOW DATABASES'), false)
  assert.ok(catalog.includes('SHOW DATABASES'))
  assert.ok(worker.includes("ready = true"))
  assert.ok(worker.includes('ensureCatalog'))
  assert.ok(worker.includes('recoverCatalog'))
})

test('worker only serializes catalog and maintenance results for the outer size guard', () => {
  const worker = readFileSync(new URL('../src/host/connection-worker.mjs', import.meta.url), 'utf8')
  assert.ok(worker.includes("message.action === 'catalog' || message.action === 'maintenance'"))
  assert.ok(worker.includes('维护结果超过 1 MiB'))
  assert.equal(worker.includes("if (Buffer.byteLength(JSON.stringify(result))"), false)
})

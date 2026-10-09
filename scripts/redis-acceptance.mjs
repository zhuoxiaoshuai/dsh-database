import assert from 'node:assert/strict'
import { createServer as createTcpServer, connect as connectTcp } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ConnectionService } from '../src/host/connection-service.ts'
import { memoryPasswordProtector } from '../src/host/saved-connections.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { registerRedisAiTools } from '../src/host/redis-ai-tools.ts'
import { createClient } from 'redis'

const directory = mkdtempSync(join(tmpdir(), 'dsh-redis-accept-'))
const executions = new ExecutionStore(directory)
const service = new ConnectionService(() => true, directory, undefined, memoryPasswordProtector, executions)
const input = {
  name: 'Disposable Redis', dialect: 'redis', host: '127.0.0.1', port: Number(process.env.DSH_REDIS_TEST_PORT || 16379),
  database: '2', oracleMode: 'service', username: '', password: '', environment: 'sit', tls: false,
}
const owner = 'redis-accept'
const command = (connection, text) => service.redisRequest(owner, connection.id, connection.generation, 'redis-command', { command: text })
const key = (connection, keyName, operation = 'read', more = {}) => service.redisRequest(owner, connection.id, connection.generation, 'redis-key', { key: keyName, operation, ...more })
try {
  const tested = await service.open(owner, input, true)
  assert.equal(tested.database, '2')
  const connected = await service.open(owner, input, false)
  assert.equal(connected.live, true)
  assert.equal(connected.settings?.password, undefined)
  assert.equal((await command(connected, 'PING')).result.type, 'string')
  assert.equal((await command(connected, 'NO_SUCH_REDIS_COMMAND')).result.type, 'error')
  await command(connected, 'SET dsh:test:string "hello redis"')
  await command(connected, 'HSET dsh:test:hash field value')
  await command(connected, 'RPUSH dsh:test:list one two')
  await command(connected, 'SADD dsh:test:set one two')
  await command(connected, 'ZADD dsh:test:zset 1 one 2 two')
  assert.equal((await key(connected, 'dsh:test:string')).keyType, 'string')
  for (const type of ['hash', 'list', 'set', 'zset']) assert.equal((await key(connected, `dsh:test:${type}`)).keyType, type)
  const raw = createClient({ socket: { host: '127.0.0.1', port: input.port }, database: 2 })
  raw.on('error', () => {})
  await raw.connect()
  try {
    await raw.set('dsh:test:binary', Buffer.from([0xff, 0x00, 0xfe]))
    await raw.set('dsh:test:large', 'x'.repeat(1024 * 1024 + 100))
  } finally { raw.destroy() }
  assert.equal((await key(connected, 'dsh:test:binary')).value.result.type, 'binary')
  assert.equal((await key(connected, 'dsh:test:large')).value.truncated, true)
  const scan = await service.redisRequest(owner, connected.id, connected.generation, 'redis-scan', { cursor: '0', match: 'dsh:test:*' })
  assert.ok(Array.isArray(scan.keys))
  assert.equal(service.list(owner)[0]?.generation, connected.generation)
  const explorerPage = await service.explorerList(owner, connected.id, connected.generation, { search: 'dsh:test:*' })
  assert.equal(explorerPage.sourceId, 'redis')
  const explorerKey = explorerPage.nodes.find(item => item.title === 'dsh:test:string')
  assert.ok(explorerKey)
  assert.equal((await service.explorerRead(owner, connected.id, connected.generation, { ref: explorerKey.ref })).keyType, 'string')
  await assert.rejects(async () => service.explorerList(owner, connected.id, 'old-generation', {}), /变化/)
  await command(connected, 'SET "dsh:test:literal*?[" special')
  const beforeSuggestions = executions.list(owner).map(item => item.executionId).sort()
  const suggest = (prefix, signal, generation = connected.generation) => service.redisRequest(owner, connected.id, generation, 'redis-key-suggest', { prefix }, signal)
  const found = await suggest('dsh:test:literal*?[')
  assert.deepEqual(found.keys, ['dsh:test:literal*?['])
  assert.ok(found.scannedPages >= 1 && found.scannedPages <= 5)
  assert.ok((await suggest('dsh:test:')).keys.includes('dsh:test:string'))
  await assert.rejects(suggest('d'), /2 个字符/)
  const cancelledSuggestion = new AbortController()
  cancelledSuggestion.abort()
  await assert.rejects(suggest('dsh:test:', cancelledSuggestion.signal), /取消/)
  await assert.rejects(suggest('dsh:test:', undefined, 'stale-generation'))
  assert.deepEqual(executions.list(owner).map(item => item.executionId).sort(), beforeSuggestions, 'remote suggestions and rejected suggestions create no execution records')
  const suggestionPath = join(directory, 'ai-executions.json')
  if (existsSync(suggestionPath)) {
    const suggestionRecord = readFileSync(suggestionPath, 'utf8')
    assert.ok(!suggestionRecord.includes('Key 补全'))
    assert.ok(!suggestionRecord.includes('dsh:test:literal'))
  }
  await key(connected, 'dsh:test:created-list', 'lpush', { value: 'first' })
  assert.equal((await key(connected, 'dsh:test:created-list')).keyType, 'list')
  await key(connected, 'dsh:test:string', 'expire', { seconds: 60 })
  assert.ok((await key(connected, 'dsh:test:string')).ttl > 0)
  await key(connected, 'dsh:test:string', 'persist')
  assert.equal((await key(connected, 'dsh:test:string')).ttl, -1)
  await command(connected, 'SELECT 3')
  assert.equal((await key(connected, 'dsh:test:string')).keyType, 'string')
  const aborted = new AbortController()
  const blocked = service.redisRequest(owner, connected.id, connected.generation, 'redis-command', { command: 'BLPOP dsh:test:never 0' }, aborted.signal)
  setTimeout(() => aborted.abort(), 100)
  await assert.rejects(blocked, /未知/)
  assert.equal(executions.list(owner).find(item => item.title === 'Redis BLPOP')?.status, 'unknown')
  const disconnectProbe = createClient({ socket: { host: '127.0.0.1', port: input.port }, database: Number(input.database) })
  disconnectProbe.on('error', () => {})
  await disconnectProbe.connect()
  try {
    const before = new Set(executions.list(owner).map(item => item.executionId))
    const interrupted = service.executeText(owner, connected.id, connected.generation, 'BLPOP dsh:test:disconnect 0')
    const rejected = assert.rejects(interrupted)
    let blockedId
    const deadline = Date.now() + 5000
    while (!blockedId) {
      const clients = String(await disconnectProbe.sendCommand(['CLIENT', 'LIST']))
      blockedId = clients.split('\n').find(line => /\bcmd=blpop\b/.test(line))?.match(/\bid=(\d+)/)?.[1]
      if (Date.now() >= deadline) throw new Error('Disposable blocking command did not arrive')
      if (!blockedId) await new Promise(done => setTimeout(done, 20))
    }
    await disconnectProbe.sendCommand(['CLIENT', 'KILL', 'ID', blockedId])
    await rejected
    const records = executions.list(owner).filter(item => !before.has(item.executionId))
    assert.equal(records.length, 1)
    assert.equal(records[0].status, 'unknown')
    await new Promise(done => setTimeout(done, 100))
    assert.ok(!String(await disconnectProbe.sendCommand(['CLIENT', 'LIST'])).includes('cmd=blpop'), 'interrupted command is not replayed')
  } finally { disconnectProbe.destroy() }
  assert.equal((await command(connected, 'PING')).result.value, 'PONG')
  const saved = readFileSync(join(directory, 'database-workspace.json'), 'utf8')
  assert.ok(!saved.includes('hello redis'))
  const failed = { ...input, port: 1 }
  await assert.rejects(service.update(owner, connected.id, failed))
  assert.equal(service.list(owner)[0].generation, connected.generation)
  const tools = new Map()
  registerRedisAiTools({ tools: { register: tool => tools.set(tool.name, tool) } }, service, executions, id => id === owner)
  const ai = (name, args, signal = new AbortController().signal) => tools.get(name).execute(args, { callId: randomUUID(), rootCallId: 'redis-accept', agent: { session: { id: owner } }, signal })
  const verifyReadTools = async (connection, config) => {
    const document = service.getExecutionDocument(owner, connection.id)
    const before = new Set(executions.list(owner).map(item => item.executionId))
    const scan = JSON.parse(await ai('redis_keys', { connectionId: connection.id, generation: connection.generation, match: 'dsh:test:*' }))
    const read = JSON.parse(await ai('redis_value', { connectionId: connection.id, generation: connection.generation, key: config.tls ? 'dsh:tls:test' : 'dsh:test:string' }))
    assert.ok(Array.isArray(scan.keys)); assert.equal(read.keyType, 'string')
    assert.equal(scan.executionStatus, undefined); assert.equal(read.executionStatus, undefined)
    const records = executions.list(owner).filter(item => !before.has(item.executionId))
    assert.equal(records.length, 2)
    assert.ok(records.every(item => item.type === 'tool' && item.status === 'succeeded' && item.events.filter(event => event.kind === 'dispatched').length === 1))
    assert.deepEqual(service.getExecutionDocument(owner, connection.id), document)
    // A transparent TCP relay delays real Redis replies, allowing deterministic network cancellation and failure.
    let hold = false
    const pairs = new Set(), buffered = []
    const relay = createTcpServer(front => {
      const back = connectTcp({ host: config.host, port: config.port })
      const pair = { front, back }; pairs.add(pair)
      front.on('error', () => {}); back.on('error', () => {})
      front.on('data', data => back.write(data))
      back.on('data', data => { if (hold) buffered.push({ front, data }); else front.write(data) })
      front.on('close', () => { back.destroy(); pairs.delete(pair) })
      back.on('close', () => front.destroy())
    })
    await new Promise(done => relay.listen(0, '127.0.0.1', done))
    let proxy
    const until = async check => {
      const deadline = Date.now() + 5000
      while (!check()) { assert.ok(Date.now() < deadline, 'read relay wait timed out'); await new Promise(done => setTimeout(done, 5)) }
    }
    try {
      proxy = await service.open(owner, { ...config, name: 'Redis owned read relay', port: relay.address().port }, false)
      hold = true
      const abort = new AbortController()
      const pending = ai('redis_keys', { connectionId: proxy.id, generation: proxy.generation }, abort.signal)
      const rejected = assert.rejects(pending)
      await until(() => buffered.length > 0)
      const pendingValue = ai('redis_value', { connectionId: proxy.id, generation: proxy.generation, key: config.tls ? 'dsh:tls:test' : 'dsh:test:string' })
      abort.abort(); await rejected
      assert.equal(executions.list(owner).find(item => item.connectionId === proxy.id && item.operation === 'redis_keys').status, 'cancelled')
      hold = false
      for (const reply of buffered.splice(0)) if (!reply.front.destroyed) reply.front.write(reply.data)
      assert.equal(JSON.parse(await pendingValue).keyType, 'string', 'cancelling one read does not close shared browsing')
      assert.ok(Array.isArray((await service.redisRequest(owner, proxy.id, proxy.generation, 'redis-scan', { cursor: '0' })).keys))
      const beforeQueue = new Set(executions.list(owner).map(item => item.executionId))
      hold = true
      const blockers = Array.from({ length: 3 }, () => ai('redis_keys', { connectionId: proxy.id, generation: proxy.generation }))
      await until(() => executions.list(owner).filter(item => !beforeQueue.has(item.executionId) && item.status === 'running').length === 3)
      const queuedAbort = new AbortController()
      const queued = ai('redis_value', { connectionId: proxy.id, generation: proxy.generation, key: 'dsh:test:string' }, queuedAbort.signal)
      const queuedRejected = assert.rejects(queued)
      const queuedRecord = executions.list(owner).find(item => !beforeQueue.has(item.executionId) && item.operation === 'redis_value')
      assert.equal(queuedRecord.status, 'checking')
      queuedAbort.abort()
      hold = false
      for (const reply of buffered.splice(0)) if (!reply.front.destroyed) reply.front.write(reply.data)
      await Promise.all(blockers); await queuedRejected
      const queuedFinished = executions.get(owner, queuedRecord.executionId)
      assert.equal(queuedFinished.status, 'cancelled')
      assert.equal(queuedFinished.events.filter(event => event.kind === 'dispatched').length, 0)
      hold = true
      const interrupted = ai('redis_keys', { connectionId: proxy.id, generation: proxy.generation })
      const failed = assert.rejects(interrupted)
      await until(() => buffered.length > 0)
      for (const pair of pairs) { pair.front.destroy(); pair.back.destroy() }
      await failed
      const latest = executions.list(owner).find(item => item.connectionId === proxy.id && item.operation === 'redis_keys')
      assert.equal(latest.status, 'failed')
      assert.equal(latest.events.filter(event => event.kind === 'dispatched').length, 1)
    } finally {
      if (proxy) await service.disconnect(owner, proxy.id)
      for (const pair of pairs) { pair.front.destroy(); pair.back.destroy() }
      await new Promise(done => relay.close(done))
    }
  }
  await verifyReadTools(connected, input)
  assert.ok(JSON.parse(await ai('redis_status', {})).connections.some(item => item.connectionId === connected.id))
  assert.ok(Array.isArray(JSON.parse(await ai('redis_keys', { connectionId: connected.id, generation: connected.generation, cursor: '0', match: 'dsh:test:*' })).keys))
  assert.equal(JSON.parse(await ai('redis_value', { connectionId: connected.id, generation: connected.generation, key: 'dsh:test:string' })).keyType, 'string')
  service.controlExecutionDocument(owner, connected.id, 'user', 'user-takeover', connected.generation, service.getExecutionDocument(owner, connected.id).revision)
  await assert.rejects(ai('redis_keys', { connectionId: connected.id, generation: connected.generation, cursor: '0' }), /接管/)
  service.controlExecutionDocument(owner, connected.id, 'ai', undefined, connected.generation, service.getExecutionDocument(owner, connected.id).revision)
  const documentBefore = service.getExecutionDocument(owner, connected.id)
  await ai('redis_execute', { connectionId: connected.id, generation: connected.generation, command: 'PING' })
  const documentAfter = service.getExecutionDocument(owner, connected.id)
  assert.equal(documentAfter.text, 'PING')
  assert.ok(documentAfter.revision > documentBefore.revision)
  const uat = await service.open(owner, { ...input, name: 'Redis UAT', environment: 'uat' }, false)
  const pvt = await service.open(owner, { ...input, name: 'Redis PVT', environment: 'pvt' }, false)
  assert.equal((await command(uat, 'PING')).result.value, 'PONG')
  assert.equal((await command(pvt, 'PING')).result.value, 'PONG')
  for (const other of [uat, pvt]) {
    await assert.rejects(ai('redis_execute', { connectionId: other.id, generation: other.generation, command: 'PING' }), /不开放/)
    assert.ok(Array.isArray(JSON.parse(await ai('redis_keys', { connectionId: other.id, generation: other.generation, cursor: '0' })).keys))
  }
  const aclPassword = `dsh-${randomUUID()}`
  await command(connected, `ACL SETUSER dsh_accept on >${aclPassword} +@all ~*`)
  try {
    const aclInput = { ...input, username: 'dsh_accept', password: aclPassword, rememberPassword: true }
    const acl = await service.open(owner, aclInput, false)
    assert.equal((await command(acl, 'PING')).result.value, 'PONG')
    await assert.rejects(service.open(owner, { ...aclInput, password: 'wrong-password' }, true))
    const storedAcl = readFileSync(join(directory, 'database-workspace.json'), 'utf8')
    assert.ok(!storedAcl.includes(aclPassword))
  } finally { await command(connected, 'ACL DELUSER dsh_accept') }
  await command(connected, 'ACL SETUSER dsh_scan_denied on >scan-denied +ping +info +select ~*')
  try {
    const restricted = await service.open(owner, { ...input, name: 'Restricted Redis', username: 'dsh_scan_denied', password: 'scan-denied' }, false)
    await assert.rejects(service.redisRequest(owner, restricted.id, restricted.generation, 'redis-key-suggest', { prefix: 'dsh:test:' }), /NOPERM|permission|允许|权限/i)
    for (const name of ['redis_keys', 'redis_value']) {
      const before = new Set(executions.list(owner).map(item => item.executionId))
      await assert.rejects(ai(name, { connectionId: restricted.id, generation: restricted.generation, key: 'dsh:test:string' }), /NOPERM|permission|允许|权限/i)
      const records = executions.list(owner).filter(item => !before.has(item.executionId))
      assert.equal(records.length, 1); assert.equal(records[0].status, 'failed')
      assert.ok(!JSON.stringify(records).includes('dsh:test:string'))
    }
  } finally { await command(connected, 'ACL DELUSER dsh_scan_denied') }
  if (process.env.DSH_REDIS_TLS_TEST === '1') {
    if (process.env.DSH_REDIS_STAGE_REPORT) writeFileSync(process.env.DSH_REDIS_STAGE_REPORT, JSON.stringify({ plain: 'PASS', tls: 'FAIL' }))
    const caPem = readFileSync(process.env.DSH_REDIS_CA_PATH, 'utf8')
    const wrongCa = readFileSync(process.env.DSH_REDIS_WRONG_CA_PATH, 'utf8')
    const tlsInput = { ...input, name: 'Disposable Redis TLS', port: Number(process.env.DSH_REDIS_TLS_PORT), tls: true, caPem }
    await assert.rejects(service.open(owner, { ...tlsInput, caPem: '' }, true))
    await assert.rejects(service.open(owner, { ...tlsInput, caPem: wrongCa }, true))
    await assert.rejects(service.open(owner, { ...tlsInput, port: Number(process.env.DSH_REDIS_TLS_MISMATCH_PORT) }, true))
    const tls = await service.open(owner, tlsInput, false)
    assert.equal((await command(tls, 'PING')).result.value, 'PONG')
    await command(tls, 'SET dsh:tls:test secure')
    assert.equal((await command(tls, 'GET dsh:tls:test')).result.value, 'secure')
    await assert.rejects(service.open(owner, { ...tlsInput, caPem: wrongCa }, false, tls.id))
    assert.equal((await command(tls, 'PING')).result.value, 'PONG', 'failed edit retains old connection')
    assert.equal(tls.settings?.caPem, undefined)
    assert.equal(tls.hasCa, true)
    assert.ok(!JSON.stringify(service.list(owner)).includes('BEGIN CERTIFICATE'))
    assert.ok(!readFileSync(join(directory, 'database-workspace.json'), 'utf8').includes('BEGIN CERTIFICATE'))
    await service.disconnect(owner, tls.id)
    const revived = await service.open(owner, { ...tlsInput, caPem: '', useSavedPassword: true }, false, tls.id)
    assert.equal((await command(revived, 'PING')).result.value, 'PONG')
    await verifyReadTools(revived, tlsInput)
    if (process.env.DSH_REDIS_STAGE_REPORT) writeFileSync(process.env.DSH_REDIS_STAGE_REPORT, JSON.stringify({ plain: 'PASS', tls: 'PASS' }))
  }
  for (const name of ['string', 'hash', 'list', 'set', 'zset', 'binary', 'large', 'created-list', 'literal*?[']) await key(connected, `dsh:test:${name}`, 'delete')
  await ai('redis_execute', { connectionId: connected.id, generation: connected.generation, command: 'FLUSHDB' }) // only DB 2 in disposable container
  const persistedExecutions = readFileSync(join(directory, 'ai-executions.json'), 'utf8')
  assert.ok(!persistedExecutions.includes('FLUSHDB dsh:'))
  assert.ok(!persistedExecutions.includes(aclPassword))
  assert.ok(!persistedExecutions.includes('BEGIN CERTIFICATE'))
  console.log('Redis disposable acceptance passed: connection, ACL, TLS when enabled, command isolation, SCAN, bounded Key suggestion, five types, TTL, delete, failed edit retention, manual SIT/UAT/PVT, AI SIT/UAT/PVT, FLUSHDB.')
} finally {
  await service.dispose()
  await executions.dispose()
  const target = resolve(directory), parent = resolve(tmpdir())
  if (target.startsWith(parent + sep) && basename(target).startsWith('dsh-redis-accept-')) rmSync(target, { recursive: true, force: true })
}

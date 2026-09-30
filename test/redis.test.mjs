import test from 'node:test'
import assert from 'node:assert/strict'
import { getDataSource, getRedisDataSource, registeredAllDataSources, createDataSourceRegistry } from '../src/host/data-sources/registry.mjs'
import { validateConnection, connectionFingerprint, canReuseSavedLogin, passwordRequired } from '../src/shared/connection-input.ts'
import { redisKeyMatches, redisScanMatch } from '../src/shared/redis-scan-match.ts'
import { authorizeRedisCommand } from '../src/host/redis-policy.ts'
import { encodeReply, geohashScore, redisLiteralScanPattern } from '../src/host/data-sources/redis/index.mjs'
import { publicConnection } from '../src/host/saved-connections.ts'
import { clientRedisSource, supportedAllDataSources } from '../src/shared/data-sources/registry.ts'
import { redisCommandDatabase, redisDatabaseIds, redisDatabaseLabel, redisSelectedDatabase } from '../src/shared/data-sources/redis.ts'
import { readFileSync } from 'node:fs'

const input = { name: '', dialect: 'redis', host: 'localhost', port: 6379, database: '0', oracleMode: 'service', username: '', password: '', environment: 'sit', tls: false }

test('Redis has an isolated contract and SQL callers reject it', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dependencies.redis, '6.2.1')
  assert.ok(pkg.files.includes('lib/redis-worker.mjs'))
  assert.deepEqual(registeredAllDataSources(), ['mysql', 'oracle', 'redis'])
  assert.deepEqual([...supportedAllDataSources], [...registeredAllDataSources(), 'kafka'])
  assert.equal(getRedisDataSource('redis').family, 'redis')
  assert.deepEqual(getRedisDataSource('redis').capabilities, clientRedisSource().capabilities)
  assert.doesNotMatch(readFileSync(new URL('../src/shared/data-sources/redis.ts', import.meta.url), 'utf8'), /from ['"](?:redis|node:|\.\.\/\.\.\/host)/)
  assert.throws(() => getDataSource('redis'), /不是 SQL/)
  assert.throws(() => getRedisDataSource('mysql'), /不是 Redis/)
  assert.throws(() => createDataSourceRegistry([{ ...getRedisDataSource('redis'), driver: {} }]), /驱动能力不完整/)
})

test('Redis accepts no password and distinguishes database and TLS in fingerprint', () => {
  const clean = validateConnection(input)
  assert.equal(clean.database, '0')
  assert.equal(clean.username, '')
  assert.equal(clean.redisMode, 'standalone')
  assert.equal(validateConnection({ ...input, redisMode: undefined }).redisMode, 'standalone')
  assert.notEqual(connectionFingerprint(clean), connectionFingerprint({ ...clean, database: '1' }))
  assert.notEqual(connectionFingerprint(clean), connectionFingerprint({ ...clean, tls: true }))
  assert.throws(() => validateConnection({ ...input, database: '01' }), /DB 编号/)
  assert.throws(() => validateConnection({ ...input, tls: false, caPem: 'CA' }), /CA 证书/)
})

test('Redis connection modes validate master name, cluster DB 0, and fingerprints', () => {
  assert.throws(() => validateConnection({ ...input, redisMode: 'replica' }), /连接方式/)
  assert.throws(() => validateConnection({ ...input, redisMode: 'sentinel', sentinelMaster: '  ' }), /Master 名称/)
  const sentinel = validateConnection({ ...input, port: 26379, redisMode: 'sentinel', sentinelMaster: ' mymaster ' })
  assert.equal(sentinel.redisMode, 'sentinel')
  assert.equal(sentinel.sentinelMaster, 'mymaster')
  assert.throws(() => validateConnection({ ...input, redisMode: 'cluster', database: '1' }), /DB 0/)
  const cluster = validateConnection({ ...input, redisMode: 'cluster', database: '0' })
  assert.equal(cluster.database, '0')
  assert.equal(cluster.redisMode, 'cluster')
  assert.equal(cluster.sentinelMaster, undefined)
  const standaloneKey = connectionFingerprint(validateConnection(input))
  const sentinelKey = connectionFingerprint(sentinel)
  const otherMaster = connectionFingerprint({ ...sentinel, sentinelMaster: 'other' })
  const clusterKey = connectionFingerprint(cluster)
  assert.match(standaloneKey, /standalone/)
  assert.match(sentinelKey, /sentinel/)
  assert.match(sentinelKey, /mymaster/)
  assert.match(clusterKey, /cluster/)
  assert.notEqual(standaloneKey, sentinelKey)
  assert.notEqual(sentinelKey, otherMaster)
  assert.notEqual(standaloneKey, clusterKey)
})

test('Redis database nodes are db0, db1… and a click selects one', () => {
  const listed = { database: '0', databases: ['0', '1', '2'], settings: { redisMode: 'standalone' } }
  assert.deepEqual(redisDatabaseIds(listed), ['0', '1', '2'])
  assert.deepEqual(redisDatabaseIds(listed).map(redisDatabaseLabel), ['db0', 'db1', 'db2'])
  assert.equal(redisSelectedDatabase(listed, ''), '')
  assert.equal(redisSelectedDatabase(listed, '1'), '1')
  assert.equal(redisSelectedDatabase(listed, '9'), '')
  assert.equal(redisCommandDatabase(listed, '1'), '1')
  assert.equal(redisCommandDatabase(listed, ''), '0')
  assert.equal(redisCommandDatabase({ database: '4' }, ''), '4')
  assert.deepEqual(redisDatabaseIds({ database: '0', settings: { redisMode: 'cluster' }, databases: ['0', '1'] }), ['0'])
  assert.deepEqual(redisDatabaseIds({ database: '4' }), ['4'])
})

test('Redis lists server databases without using the shared client SELECT', async () => {
  const driver = getRedisDataSource('redis').driver
  const configured = redisMock(command => {
    if (command === 'CONFIG') return [Buffer.from('databases'), Buffer.from('3')]
    if (command === 'INFO') throw new Error('NOPERM')
    throw new Error(command)
  })
  assert.deepEqual(await driver.databases(configured.client, { database: '0', redisMode: 'standalone' }), ['0', '1', '2'])
  assert.equal(configured.calls.some(call => call[0] === 'SELECT'), false)
  const denied = redisMock(command => {
    if (command === 'CONFIG') throw new Error('NOPERM')
    if (command === 'INFO') return 'db2:keys=1,expires=0,avg_ttl=0\n'
    throw new Error(command)
  })
  const fallback = await driver.databases(denied.client, { database: '0' })
  assert.equal(fallback.length, 16)
  assert.equal(fallback[0], '0')
  assert.equal(fallback[2], '2')
  const cluster = redisMock(() => { throw new Error('should not query') })
  assert.deepEqual(await driver.databases(cluster.client, { database: '0', redisMode: 'cluster' }), ['0'])
})

test('cluster SCAN pages each master with a nodeIndex:nodeCursor', async () => {
  const calls = []
  const nodes = [0, 1].map(index => ({
    async sendCommand(args) {
      calls.push([index, [...args]])
      if (index === 0 && args[1] === '0') return ['42', ['a', 'a']]
      if (index === 0) return ['0', ['b']]
      return ['0', ['c']]
    },
  }))
  const client = { redisMode: 'cluster', masters: nodes, async nodeClient(node) { return node } }
  const driver = getRedisDataSource('redis').driver
  const first = await driver.scan(client, { cursor: '0', match: 'user:*' })
  assert.deepEqual(first.keys, ['a'])
  assert.equal(first.cursor, '0:42')
  assert.equal(first.complete, false)
  assert.deepEqual(calls[0][1], ['SCAN', '0', 'MATCH', 'user:*', 'COUNT', '100'])
  const second = await driver.scan(client, { cursor: first.cursor, match: 'user:*' })
  assert.deepEqual(second.keys, ['b'])
  assert.equal(second.cursor, '1:0')
  const third = await driver.scan(client, { cursor: second.cursor })
  assert.deepEqual(third.keys, ['c'])
  assert.equal(third.cursor, '0')
  assert.equal(third.complete, true)
  assert.equal(calls.length, 3)
  assert.equal(calls[2][0], 1)
  assert.equal(calls[2][1][1], '0')
  await assert.rejects(driver.scan(client, { cursor: '9:0' }), /游标无效/)
})

test('saved Redis login reopens without a password form, same as a remembered MySQL password', () => {
  assert.equal(passwordRequired('redis'), false)
  assert.equal(passwordRequired('mysql'), true)
  assert.equal(canReuseSavedLogin({ dialect: 'redis' }), true)
  assert.equal(canReuseSavedLogin({ dialect: 'redis', hasPassword: true }), true)
  assert.equal(canReuseSavedLogin({ dialect: 'mysql' }), false)
  assert.equal(canReuseSavedLogin({ dialect: 'mysql', hasPassword: true }), true)
})

test('command parsing keeps quoted arguments and Host blacklist matches exact command or subcommand', () => {
  assert.deepEqual(authorizeRedisCommand('SET "a b" "x\\ny"'), ['SET', 'a b', 'x\ny'])
  assert.deepEqual(authorizeRedisCommand('FLUSHALL'), ['FLUSHALL'])
  assert.throws(() => authorizeRedisCommand('CONFIG SET x y', [['CONFIG', 'SET']]), /禁止/)
  assert.deepEqual(authorizeRedisCommand('CONFIG GET x', [['CONFIG', 'SET']]), ['CONFIG', 'GET', 'x'])
  assert.throws(() => authorizeRedisCommand('PING\nFLUSHALL'), /一条/)
  const previous = process.env.DSH_REDIS_COMMAND_BLACKLIST
  try {
    process.env.DSH_REDIS_COMMAND_BLACKLIST = '{bad'
    assert.throws(() => authorizeRedisCommand('PING'), /黑名单配置无效/)
  } finally {
    if (previous === undefined) delete process.env.DSH_REDIS_COMMAND_BLACKLIST
    else process.env.DSH_REDIS_COMMAND_BLACKLIST = previous
  }
})

test('Redis replies retain nil, binary, map and set while bounding output', () => {
  assert.deepEqual(encodeReply(null).result, { type: 'nil' })
  assert.equal(encodeReply(Buffer.from([0xff, 0x00])).result.type, 'binary')
  assert.equal(encodeReply(new Map([['a', 1]])).result.type, 'map')
  assert.equal(encodeReply(new Set(['a'])).result.type, 'set')
  assert.equal(encodeReply(Buffer.alloc(1024 * 1024 + 1, 97)).truncated, true)
})

test('connection snapshots do not expose custom CA content', () => {
  const row = { id: 'redis-1', settings: { ...input, caPem: 'SECRET_CA', tls: true }, protectedCa: 'encrypted' }
  const snapshot = publicConnection(row)
  assert.equal(snapshot.settings.caPem, undefined)
  assert.equal(snapshot.hasCa, true)
  assert.ok(!JSON.stringify(snapshot).includes('SECRET_CA'))
})

test('Redis key search wraps plain text and keeps globs', () => {
  assert.equal(redisScanMatch(''), '*')
  assert.equal(redisScanMatch('   '), '*')
  assert.equal(redisScanMatch('order'), '*order*')
  assert.equal(redisScanMatch('order user'), '*order*')
  assert.equal(redisScanMatch('user:*'), 'user:*')
  assert.equal(redisScanMatch('a]b\\c'), '*a\\]b\\\\c*')
  assert.equal(redisKeyMatches('app:order:1', 'order'), true)
  assert.equal(redisKeyMatches('app:Order:User', 'order user'), true)
  assert.equal(redisKeyMatches('app:order:1', 'order user'), false)
  assert.equal(redisKeyMatches('User:1', 'user:*'), true)
  assert.equal(redisKeyMatches('other', ''), true)
})

test('Key suggestion escapes glob characters and bounds pages, duplicates and results', async () => {
  assert.equal(redisLiteralScanPattern('a*?[\\'), 'a\\*\\?\\[\\\\*')
  assert.throws(() => redisLiteralScanPattern('a'), /2 个字符/)
  const driver = getRedisDataSource('redis').driver
  const calls = []
  const client = { async sendCommand(args) {
    calls.push(args)
    return [String(calls.length), calls.length === 1 ? [] : [Buffer.from('ab:one'), Buffer.from('ab:one'), Buffer.from([0xff])]]
  } }
  const result = await driver.suggestKeys(client, { prefix: 'ab' })
  assert.deepEqual(result.keys, ['ab:one'])
  assert.equal(result.complete, false)
  assert.equal(result.scannedPages, 5)
  assert.equal(calls.length, 5)
  assert.ok(calls.every(args => args.join(' ').includes('MATCH ab* COUNT 100')))
  const many = { async sendCommand() { return ['7', Array.from({ length: 100 }, (_, index) => `ab:${index}`)] } }
  assert.equal((await driver.suggestKeys(many, { prefix: 'ab' })).keys.length, 30)
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(driver.suggestKeys(client, { prefix: 'ab' }, abort.signal), /取消/)
})

function redisMock(reply) {
  const calls = []
  const client = { async sendCommand(args) {
    const command = String(args[0]).toUpperCase()
    calls.push([command, args.map(item => Buffer.isBuffer(item) ? item.toString('utf8') : String(item))])
    const result = reply(command, args)
    if (result instanceof Error) throw result
    return result
  } }
  return { client, calls }
}

test('key read reports string, list, hash ttl, stream, json, bitmap and leaves small zset scores as zset', async () => {
  const driver = getRedisDataSource('redis').driver
  const stringKey = redisMock(command => {
    if (command === 'TYPE') return 'string'
    if (command === 'TTL') return -1
    if (command === 'OBJECT') return 'raw'
    if (command === 'GET') return Buffer.from('hello')
    throw new Error(command)
  })
  const text = await driver.key(stringKey.client, { key: 'a', operation: 'read' })
  assert.equal(text.keyType, 'string')
  assert.equal(text.value.result.value, 'hello')
  assert.equal(stringKey.calls.some(call => call[0] === 'PFCOUNT'), false)

  const hll = redisMock(command => {
    if (command === 'TYPE') return 'string'
    if (command === 'TTL') return -1
    if (command === 'OBJECT') return 'raw'
    if (command === 'GET') return Buffer.concat([Buffer.from('HYLL'), Buffer.alloc(12)])
    if (command === 'PFCOUNT') return 4
    throw new Error(command)
  })
  const log = await driver.key(hll.client, { key: 'h', operation: 'read' })
  assert.equal(log.keyType, 'hyperloglog')
  assert.equal(log.card.count, '4')

  const list = redisMock(command => {
    if (command === 'TYPE') return 'list'
    if (command === 'TTL') return -1
    if (command === 'LRANGE') return ['a', 'b']
    if (command === 'LLEN') return 2
    throw new Error(command)
  })
  const listed = await driver.key(list.client, { key: 'l', operation: 'read' })
  assert.equal(listed.keyType, 'list')
  assert.deepEqual(listed.rows.map(row => row.id), ['1', '2'])

  const hash = redisMock(command => {
    if (command === 'TYPE') return 'hash'
    if (command === 'TTL') return -1
    if (command === 'HSCAN') return ['0', ['field', 'value']]
    if (command === 'HTTL') throw new Error('ERR unknown command HTTL')
    throw new Error(command)
  })
  const hashed = await driver.key(hash.client, { key: 'h', operation: 'read' })
  assert.equal(hashed.rows[0].cells.ttl, '-1')
  const hashTtl = redisMock(command => {
    if (command === 'TYPE') return 'hash'
    if (command === 'TTL') return -1
    if (command === 'HSCAN') return ['0', ['field', 'value']]
    if (command === 'HTTL') return [9]
    throw new Error(command)
  })
  assert.equal((await driver.key(hashTtl.client, { key: 'h', operation: 'read' })).rows[0].cells.ttl, '9')

  const stream = redisMock((command, args) => {
    if (command === 'TYPE') return 'stream'
    if (command === 'TTL') return -1
    if (command === 'XRANGE') return args[2] === '-' ? [['8-1', ['user', 'a', 'ok', '1']]] : []
    throw new Error(command)
  })
  const streamed = await driver.key(stream.client, { key: 's', operation: 'read' })
  assert.equal(streamed.keyType, 'stream')
  assert.equal(streamed.rows[0].cells.fields, 'user=a\nok=1')
  assert.equal(streamed.cursor, '8-1')
  await driver.key(stream.client, { key: 's', operation: 'read', cursor: '8-1' })
  assert.equal(stream.calls.at(-1)[1][2], '(8-1')

  const json = redisMock(command => {
    if (command === 'TYPE') return 'ReJSON-RL'
    if (command === 'TTL') return -1
    if (command === 'JSON.GET') return '{"a":1}'
    throw new Error(command)
  })
  const document = await driver.key(json.client, { key: 'j', operation: 'read' })
  assert.equal(document.keyType, 'json')
  assert.equal(document.value.result.value, '{"a":1}')

  const zset = redisMock(command => {
    if (command === 'TYPE') return 'zset'
    if (command === 'TTL') return -1
    if (command === 'ZSCAN') return ['0', ['one', '1']]
    if (command === 'GEOPOS') return [['13.3', '38.1']]
    throw new Error(command)
  })
  const scored = await driver.key(zset.client, { key: 'z', operation: 'read' })
  assert.equal(scored.keyType, 'zset')
  assert.equal(scored.rows[0].cells.score, '1')

  const lon = 13.361389
  const lat = 38.115556
  const score = geohashScore(lon, lat)
  assert.ok(score >= 2 ** 32)
  const geo = redisMock(command => {
    if (command === 'TYPE') return 'zset'
    if (command === 'TTL') return -1
    if (command === 'ZSCAN') return ['0', ['palermo', String(score)]]
    if (command === 'GEOPOS') return [[String(lon), String(lat)]]
    throw new Error(command)
  })
  const place = await driver.key(geo.client, { key: 'g', operation: 'read' })
  assert.equal(place.keyType, 'geo')
  assert.equal(place.rows[0].cells.lon, String(lon))
  assert.equal(place.rows[0].cells.lat, String(lat))

  const bits = redisMock((command, args) => {
    if (command === 'TYPE') return 'string'
    if (command === 'TTL') return -1
    if (command === 'OBJECT') return 'raw'
    if (command === 'GETRANGE') return Buffer.from('x')
    if (command === 'STRLEN') return 1
    if (command === 'BITFIELD') return Array((args.length - 2) / 3).fill(0)
    throw new Error(command)
  })
  const bitmap = await driver.key(bits.client, { key: 'b', operation: 'read', bits: true })
  assert.equal(bitmap.keyType, 'bitmap')
  assert.equal(bitmap.rows.length, 8)
  assert.equal(bitmap.more, false)

  const bloom = redisMock(command => {
    if (command === 'TYPE') return 'MBbloom--'
    if (command === 'TTL') return -1
    if (command === 'BF.INFO') throw new Error('ERR unknown command `BF.INFO`')
    throw new Error(command)
  })
  await assert.rejects(driver.key(bloom.client, { key: 'bloom', operation: 'read' }), /unknown command/)
})

test('key writes rename, setbit and reject empty stream entries', async () => {
  const driver = getRedisDataSource('redis').driver
  const taken = redisMock(command => command === 'RENAMENX' ? 0 : new Error(command))
  await assert.rejects(driver.key(taken.client, { key: 'a', operation: 'rename', value: 'b' }), /已存在/)
  const renamed = redisMock(command => command === 'RENAMENX' ? 1 : new Error(command))
  assert.equal((await driver.key(renamed.client, { key: 'a', operation: 'rename', value: 'b' })).result.result.value, '1')
  const bit = redisMock(command => command === 'SETBIT' ? 0 : new Error(command))
  await driver.key(bit.client, { key: 'b', operation: 'setbit', offset: 3, value: '1' })
  assert.deepEqual(bit.calls[0][1], ['SETBIT', 'b', '3', '1'])
  const stream = redisMock(() => new Error('should not send'))
  await assert.rejects(driver.key(stream.client, { key: 's', operation: 'xadd', entries: ['', 'v'] }), /参数无效/)
})

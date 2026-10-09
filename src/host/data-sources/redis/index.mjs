import { createClient, createCluster, createSentinel, RESP_TYPES } from 'redis'
import { nativeErrorText } from '../../connect-error.mjs'
import { redisRuntime } from './runtime.mjs'

const MAX_BYTES = 1024 * 1024
const PAGE = 100
const blobMapping = { [RESP_TYPES.BLOB_STRING]: Buffer }
const text = value => Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')
const KEYLESS = new Set(['ACL', 'ASKING', 'AUTH', 'BGREWRITEAOF', 'BGSAVE', 'CLIENT', 'CLUSTER', 'COMMAND', 'CONFIG', 'DBSIZE', 'ECHO', 'FAILOVER', 'FLUSHALL', 'FLUSHDB', 'FUNCTION', 'HELLO', 'INFO', 'LASTSAVE', 'LATENCY', 'MODULE', 'MONITOR', 'PING', 'PSYNC', 'PUBSUB', 'READWRITE', 'READONLY', 'REPLICAOF', 'REPLCONF', 'RESET', 'ROLE', 'SAVE', 'SCAN', 'SCRIPT', 'SELECT', 'SENTINEL', 'SHUTDOWN', 'SLAVEOF', 'SLOWLOG', 'SWAPDB', 'SYNC', 'TIME', 'WAIT'])

function redisModeOf(input) {
  if (input?.redisMode === undefined || input?.redisMode === 'standalone') return 'standalone'
  if (input.redisMode === 'sentinel' || input.redisMode === 'cluster') return input.redisMode
  throw new Error('Redis 连接方式无效。')
}
function assertRedisTarget(database, input = {}) {
  const mode = redisModeOf(input)
  if (!/^(0|[1-9]\d{0,4})$/.test(String(database ?? '')) || Number(database) > 65535) throw new Error('Redis DB 编号必须为 0–65535。')
  if (mode === 'cluster' && String(database) !== '0') throw new Error('Redis 集群只使用 DB 0。')
  if (mode === 'sentinel' && (typeof input.sentinelMaster !== 'string' || input.sentinelMaster.length > 128 || !input.sentinelMaster.trim())) throw new Error('请填写 Master 名称。')
  return mode
}
function authOptions(input) {
  return { ...(input.username ? { username: input.username } : {}), ...(input.password ? { password: input.password } : {}) }
}
function socketOptions(input) {
  return { connectTimeout: 8000, reconnectStrategy: false, ...(input.tls ? { tls: true, ...(input.caPem ? { ca: input.caPem } : {}) } : {}) }
}
function createOptions(input) {
  return { socket: { host: input.host, port: input.port, ...socketOptions(input) }, database: Number(input.database), ...authOptions(input) }
}
function routingKey(args) {
  const command = String(args[0] || '').toUpperCase()
  if (command === 'EVAL' || command === 'EVALSHA' || command === 'EVAL_RO' || command === 'EVALSHA_RO' || command === 'FCALL' || command === 'FCALL_RO') {
    const count = Number(args[2])
    return Number.isInteger(count) && count > 0 ? args[3] : undefined
  }
  const sub = String(args[1] || '').toUpperCase()
  if (command === 'MEMORY') return sub === 'USAGE' ? args[2] : undefined
  if (command === 'OBJECT') return sub && sub !== 'HELP' ? args[2] : undefined
  if (command === 'BITOP') return args[2]
  if (command === 'MIGRATE') return args[3]
  if (!args[1] || KEYLESS.has(command)) return undefined
  return args[1]
}
function isClusterClient(client) {
  return client?.redisMode === 'cluster' && Array.isArray(client.masters) && typeof client.nodeClient === 'function'
}
function adapt(source, sendCommand, extra = {}) {
  const client = {
    connect: () => source.connect(),
    on(event, handler) {
      source.on(event, handler)
      if (event === 'end') source.on('disconnect', handler)
      return this
    },
    destroy: () => source.destroy(),
    sendCommand,
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(extra))) Object.defineProperty(client, key, descriptor)
  return client
}

function commandCredentials(credentials, requested) {
  const database = requested === undefined || requested === null || requested === '' ? credentials.database : requested
  assertRedisTarget(database, credentials)
  return { ...credentials, database: String(database) }
}
function rememberServerError(client) {
  let server
  client.on('error', error => { if (!server) server = error })
  return () => server
}

async function failConnect(client, error, serverError) {
  await new Promise(resolve => setImmediate(resolve))
  const server = serverError()
  const serverText = nativeErrorText(server, '')
  const failure = serverText && !/client is closed/i.test(serverText) ? server : error
  try { client.destroy() } catch { /* already closed */ }
  throw failure
}

async function open(input) {
  const mode = assertRedisTarget(input.database, input)
  if (mode === 'standalone') {
    const client = createClient(createOptions(input)).withTypeMapping(blobMapping)
    const serverError = rememberServerError(client)
    try { await client.connect(); return client }
    catch (error) { await failConnect(client, error, serverError) }
  }
  const source = mode === 'cluster'
    ? createCluster({
      rootNodes: [{ socket: { host: input.host, port: input.port } }],
      defaults: { ...authOptions(input), socket: socketOptions(input) },
    }).withTypeMapping(blobMapping)
    : createSentinel({
      name: input.sentinelMaster.trim(),
      sentinelRootNodes: [{ host: input.host, port: input.port }],
      nodeClientOptions: { ...authOptions(input), database: Number(input.database), socket: socketOptions(input) },
      sentinelClientOptions: { ...authOptions(input), socket: socketOptions(input) },
    }).withTypeMapping(blobMapping)
  const client = mode === 'cluster'
    ? adapt(source, args => source.sendCommand(routingKey(args), undefined, args), {
      redisMode: 'cluster',
      get masters() { return source.masters },
      async nodeClient(node) {
        const child = await source.nodeClient(node)
        return { sendCommand: args => child.sendCommand(args, { typeMapping: blobMapping }) }
      },
    })
    : adapt(source, args => source.sendCommand(undefined, args))
  const serverError = rememberServerError(source)
  try { await source.connect(); return client }
  catch (error) { await failConnect(source, error, serverError) }
}
async function close(client) { try { await client?.destroy() } catch { /* already closed */ } }

function argumentsFor(value) {
  if (!Array.isArray(value) || !value.length || value.length > 256 || value.some(arg => typeof arg !== 'string') || Buffer.byteLength(value.join('\0')) > 65536) throw new Error('单次命令参数无效或超过 64 KiB。')
  return value
}
async function send(client, args) { return client.sendCommand(argumentsFor(args)) }

export function encodeReply(reply) {
  const budget = { left: MAX_BYTES, truncated: false }
  const take = data => { const part = data.subarray(0, Math.max(0, budget.left)); budget.left -= part.length; if (part.length < data.length) budget.truncated = true; return part }
  const visit = (item, depth = 0) => {
    if (depth > 12 || budget.left <= 0) { budget.truncated = true; return { type: 'truncated' } }
    if (item == null) return { type: 'nil' }
    if (Buffer.isBuffer(item) || typeof item === 'string') {
      const full = Buffer.isBuffer(item) ? item : Buffer.from(item)
      const part = take(full), decoded = part.toString('utf8'), binary = !Buffer.from(decoded).equals(part)
      return { type: binary ? 'binary' : 'string', value: binary ? part.toString('base64') : decoded, length: full.length, ...(binary ? { encoding: 'base64' } : {}) }
    }
    if (typeof item === 'number' || typeof item === 'bigint') return { type: 'integer', value: String(item) }
    if (item instanceof Error) return { type: 'error', value: take(Buffer.from(item.message)).toString('utf8') }
    if (Array.isArray(item) || item instanceof Set) {
      const values = Array.isArray(item) ? item : [...item]
      if (values.length > 1000) budget.truncated = true
      return { type: Array.isArray(item) ? 'array' : 'set', value: values.slice(0, 1000).map(value => visit(value, depth + 1)) }
    }
    const values = item instanceof Map ? [...item] : Object.entries(item)
    if (values.length > 1000) budget.truncated = true
    return { type: 'map', value: values.slice(0, 1000).map(([key, value]) => [visit(key, depth + 1), visit(value, depth + 1)]) }
  }
  const result = visit(reply)
  return { result, truncated: budget.truncated }
}

function cursorReply(reply) {
  const pair = Array.isArray(reply) ? reply : [reply.cursor, reply.keys ?? reply.tuples]
  const cursor = text(pair[0])
  if (!/^\d+$/.test(cursor) || !Array.isArray(pair[1])) throw new Error('SCAN 响应无效。')
  return { cursor, values: pair[1] }
}
function scanMatch(input) {
  return typeof input.match === 'string' && input.match.length <= 256 ? input.match : '*'
}
function clusterCursor(value, count) {
  if (value === undefined || value === '0') return { index: 0, cursor: '0' }
  const match = /^(\d{1,6}):(\d{1,30})$/.exec(typeof value === 'string' ? value : '')
  const index = match ? Number(match[1]) : -1
  if (!match || index >= count) throw new Error('SCAN 游标无效。')
  return { index, cursor: match[2] }
}
async function scan(client, input) {
  const match = scanMatch(input)
  if (isClusterClient(client)) {
    const masters = client.masters
    if (!masters.length) throw new Error('集群没有可用的主节点。')
    const position = clusterCursor(input.cursor, masters.length)
    const node = await client.nodeClient(masters[position.index])
    const page = cursorReply(await send(node, ['SCAN', position.cursor, 'MATCH', match, 'COUNT', String(PAGE)]))
    const names = page.values.map(text)
    const cursor = page.cursor !== '0' ? `${position.index}:${page.cursor}` : position.index + 1 < masters.length ? `${position.index + 1}:0` : '0'
    return { cursor, keys: [...new Set(names)], scanned: names.length, complete: cursor === '0' }
  }
  const cursor = typeof input.cursor === 'string' && /^\d{1,30}$/.test(input.cursor) ? input.cursor : '0'
  const page = cursorReply(await send(client, ['SCAN', cursor, 'MATCH', match, 'COUNT', String(PAGE)]))
  const names = page.values.map(text)
  return { cursor: page.cursor, keys: [...new Set(names)], scanned: names.length, complete: page.cursor === '0' }
}

export function redisLiteralScanPattern(prefix) {
  if (typeof prefix !== 'string' || Array.from(prefix).length < 2 || Buffer.byteLength(prefix) > 128) throw new Error('Key 补全前缀需为 2 个字符以上且不超过 128 字节。')
  const pattern = prefix.replace(/[\\*?\[\]]/g, '\\$&') + '*'
  if (Buffer.byteLength(pattern) > 256) throw new Error('Key 补全前缀包含过多特殊字符。')
  return pattern
}

async function suggestKeys(client, input, signal) {
  const match = redisLiteralScanPattern(input.prefix)
  const keys = new Set()
  const cluster = isClusterClient(client)
  const targets = cluster ? client.masters : [null]
  if (cluster && !targets.length) throw new Error('集群没有可用的主节点。')
  let cursor = '0', pages = 0, stoppedEarly = false
  for (let index = 0; index < targets.length; index++) {
    const node = cluster ? await client.nodeClient(targets[index]) : client
    cursor = '0'
    do {
      if (signal?.aborted) throw new Error('读取已取消。')
      const page = cursorReply(await send(node, ['SCAN', cursor, 'MATCH', match, 'COUNT', String(PAGE)]))
      pages += 1
      cursor = page.cursor
      for (const value of page.values) {
        if (Buffer.isBuffer(value) && !Buffer.from(value.toString('utf8'), 'utf8').equals(value)) continue
        const name = text(value)
        if (name.startsWith(input.prefix) && Buffer.byteLength(name) <= 4096) keys.add(name)
        if (keys.size >= 30) break
      }
    } while (cursor !== '0' && pages < 5 && keys.size < 30)
    if (cursor !== '0' || pages >= 5 || keys.size >= 30) {
      stoppedEarly = cursor !== '0' || index + 1 < targets.length
      break
    }
  }
  if (signal?.aborted) throw new Error('读取已取消。')
  return { keys: [...keys], complete: cluster ? !stoppedEarly && cursor === '0' : cursor === '0', scannedPages: pages }
}
const GEO_LAT_MIN = -85.05112878
const GEO_LAT_MAX = 85.05112878
const GEO_LON_MIN = -180
const GEO_LON_MAX = 180

function commandMissing(error) {
  return /unknown command/i.test(String(error instanceof Error ? error.message : error))
}
function cellText(item) {
  if (Buffer.isBuffer(item)) {
    const decoded = item.toString('utf8')
    if (!Buffer.from(decoded).equals(item)) return `(binary, ${item.length} bytes)`
    return decoded
  }
  return text(item)
}
function looksLikeHyperLogLog(value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''))
  return buf.length >= 16 && buf.subarray(0, 4).toString('latin1') === 'HYLL'
}
function namedType(type) {
  if (type === 'rejson-rl' || type === 'json') return 'json'
  if (type === 'tsdb-type' || type === 'timeseries') return 'timeseries'
  if (type.includes('bloom')) return 'bloom'
  return type
}
function numericCursor(input) {
  return typeof input.cursor === 'string' && /^\d{1,30}$/.test(input.cursor) ? input.cursor : '0'
}
function streamCursor(input) {
  return typeof input.cursor === 'string' && /^\d{1,20}-\d{1,10}$/.test(input.cursor) ? input.cursor : ''
}
function spreadGeo(value) {
  let bits = BigInt(value)
  const steps = [[16n, 0x0000ffff0000ffffn], [8n, 0x00ff00ff00ff00ffn], [4n, 0x0f0f0f0f0f0f0f0fn], [2n, 0x3333333333333333n], [1n, 0x5555555555555555n]]
  for (const [shift, mask] of steps) bits = (bits | (bits << shift)) & mask
  return bits
}
export function geohashScore(lon, lat) {
  const latOffset = Math.min(Math.floor(((lat - GEO_LAT_MIN) / (GEO_LAT_MAX - GEO_LAT_MIN)) * 2 ** 26), 2 ** 26 - 1)
  const lonOffset = Math.min(Math.floor(((lon - GEO_LON_MIN) / (GEO_LON_MAX - GEO_LON_MIN)) * 2 ** 26), 2 ** 26 - 1)
  return Number(spreadGeo(latOffset) | (spreadGeo(lonOffset) << 1n))
}
function isGeoScore(score, lon, lat) {
  if (!Number.isInteger(score) || score < 2 ** 32) return false
  if (lon < GEO_LON_MIN || lon > GEO_LON_MAX || lat < GEO_LAT_MIN || lat > GEO_LAT_MAX) return false
  return Math.abs(geohashScore(lon, lat) - score) <= 1
}
function positionOf(reply) {
  const row = Array.isArray(reply) ? reply[0] : undefined
  if (!Array.isArray(row) || row[0] == null || row[1] == null) return undefined
  const lon = Number(text(row[0]))
  const lat = Number(text(row[1]))
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : undefined
}
function infoLines(reply) {
  if (!Array.isArray(reply)) return [{ label: 'INFO', value: cellText(reply) }]
  const lines = []
  for (let index = 0; index + 1 < reply.length; index += 2) lines.push({ label: cellText(reply[index]), value: cellText(reply[index + 1]) })
  if (reply.length % 2 === 1) lines.push({ label: 'INFO', value: cellText(reply[reply.length - 1]) })
  return lines
}
function invalidEdit() { throw new Error('Key 编辑参数无效。') }
function bounded(value, max) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max) invalidEdit()
  return value
}
async function optionalCommand(client, args) {
  try { return await send(client, args) }
  catch (error) {
    if (commandMissing(error)) return undefined
    throw error
  }
}

async function key(client, input) {
  const name = input.key
  if (typeof name !== 'string' || !name || Buffer.byteLength(name) > 4096) throw new Error('Key 无效。')
  const operation = input.operation || 'read'
  if (operation === 'delete') return { result: encodeReply(await send(client, ['DEL', name])) }
  if (operation === 'persist') return { result: encodeReply(await send(client, ['PERSIST', name])) }
  if (operation === 'expire') {
    if (!Number.isInteger(input.seconds) || input.seconds < 1 || input.seconds > 2147483647) throw new Error('TTL 秒数无效。')
    return { result: encodeReply(await send(client, ['EXPIRE', name, String(input.seconds)])) }
  }
  if (operation !== 'read') return mutateKey(client, name, operation, input)
  return readKey(client, name, input)
}
async function mutateKey(client, name, operation, input) {
  if (operation === 'rename') {
    const next = bounded(input.value, 4096)
    if (!next.trim() || next === name) invalidEdit()
    const reply = Number(text(await send(client, ['RENAMENX', name, next])))
    if (reply === 0) throw new Error('目标 Key 已存在。')
    return { result: encodeReply(reply) }
  }
  if (operation === 'setbit') {
    if (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > 4294967295 || (input.value !== '0' && input.value !== '1')) invalidEdit()
    return { result: encodeReply(await send(client, ['SETBIT', name, String(input.offset), input.value])) }
  }
  if (operation === 'xdel') {
    if (typeof input.id !== 'string' || !/^\d{1,20}-\d{1,10}$/.test(input.id)) invalidEdit()
    return { result: encodeReply(await send(client, ['XDEL', name, input.id])) }
  }
  if (operation === 'xadd') {
    const entries = Array.isArray(input.entries) ? input.entries : (typeof input.field === 'string' && typeof input.value === 'string' ? [input.field, input.value] : undefined)
    if (!entries || entries.length < 2 || entries.length > 64 || entries.length % 2 || entries.some((item, index) => typeof item !== 'string' || (index % 2 === 0 && !item) || Buffer.byteLength(item) > 65536)) invalidEdit()
    return { result: encodeReply(await send(client, ['XADD', name, '*', ...entries])) }
  }
  if (operation === 'geoadd') {
    const member = bounded(input.value, 4096)
    if (!member || !Number.isFinite(Number(input.lon)) || !Number.isFinite(Number(input.lat))) invalidEdit()
    const reply = await send(client, ['GEOADD', name, String(input.lon), String(input.lat), member])
    if (typeof input.previous === 'string' && input.previous && input.previous !== member) await send(client, ['ZREM', name, bounded(input.previous, 4096)])
    return { result: encodeReply(reply) }
  }
  if (operation === 'tsadd') {
    const value = bounded(input.value, 65536)
    if (!/^\d{1,20}$/.test(String(input.timestamp ?? ''))) invalidEdit()
    return { result: encodeReply(await send(client, ['TS.ADD', name, String(input.timestamp), value])) }
  }
  if (operation === 'hexpire') {
    const field = bounded(input.field, 4096)
    if (!field || !Number.isInteger(input.seconds) || input.seconds < 1 || input.seconds > 2147483647) invalidEdit()
    return { result: encodeReply(await send(client, ['HEXPIRE', name, String(input.seconds), 'FIELDS', '1', field])) }
  }
  const field = input.field
  const value = input.value
  if (typeof value !== 'string' || Buffer.byteLength(value) > 65536) throw new Error('值超过 64 KiB。')
  const command = {
    set: ['SET', name, value], hset: ['HSET', name, field, value], hdel: ['HDEL', name, field],
    lpush: ['LPUSH', name, value], lset: ['LSET', name, String(input.index), value], lrem: ['LREM', name, '1', value],
    sadd: ['SADD', name, value], srem: ['SREM', name, value],
    zadd: ['ZADD', name, String(input.score), value], zrem: ['ZREM', name, value],
    pfadd: ['PFADD', name, value], bfadd: ['BF.ADD', name, value], bfexists: ['BF.EXISTS', name, value],
    jsonset: ['JSON.SET', name, '$', value],
  }[operation]
  if (!command || command.some(arg => typeof arg !== 'string') || (['hset', 'hdel', 'hexpire'].includes(operation) && (typeof field !== 'string' || !field || Buffer.byteLength(field) > 4096)) || (operation === 'lset' && (!Number.isInteger(input.index) || input.index < 0)) || (operation === 'zadd' && !Number.isFinite(input.score))) invalidEdit()
  if (typeof input.previous === 'string' && input.previous && Buffer.byteLength(input.previous) > 4096) invalidEdit()
  const reply = await send(client, command)
  if (operation === 'hset' && typeof input.previous === 'string' && input.previous && input.previous !== field) await send(client, ['HDEL', name, input.previous])
  if ((operation === 'sadd' || operation === 'zadd') && typeof input.previous === 'string' && input.previous && input.previous !== value) await send(client, [operation === 'sadd' ? 'SREM' : 'ZREM', name, input.previous])
  if (operation === 'hset' && Number.isInteger(input.seconds) && input.seconds >= 1 && input.seconds <= 2147483647) await send(client, ['HEXPIRE', name, String(input.seconds), 'FIELDS', '1', field])
  return { result: encodeReply(reply) }
}
async function readKey(client, name, input) {
  const type = text(await send(client, ['TYPE', name])).toLowerCase()
  const ttl = Number(text(await send(client, ['TTL', name])))
  const offset = Number.isInteger(input.offset) && input.offset >= 0 && input.offset <= (input.bits === true ? 4294967295 : 1000000) ? input.offset : 0
  const cursor = numericCursor(input)
  const base = { key: name, ttl, offset }
  if (type === 'none') return { ...base, keyType: 'none', value: encodeReply(null), more: false }
  if (type === 'string') return readString(client, name, input, base, offset)
  if (type === 'list') return readList(client, name, base, offset)
  if (type === 'hash' || type === 'set' || type === 'zset') return readMembers(client, name, type, base, cursor)
  if (type === 'stream') return readStream(client, name, base, streamCursor(input))
  const keyType = namedType(type)
  if (keyType === 'json') return { ...base, keyType, value: encodeReply(await send(client, ['JSON.GET', name])), more: false }
  if (keyType === 'timeseries') return readSeries(client, name, base, cursor)
  if (keyType === 'bloom') {
    const reply = await send(client, ['BF.INFO', name])
    return { ...base, keyType, value: encodeReply(reply), card: { lines: infoLines(reply) }, more: false }
  }
  return { ...base, keyType: type, value: encodeReply(null), more: false }
}
async function readString(client, name, input, base, offset) {
  let encoding = ''
  try { encoding = text(await send(client, ['OBJECT', 'ENCODING', name])).toLowerCase() } catch { encoding = '' }
  if (input.bits === true && encoding !== 'hyperloglog') {
    const head = await send(client, ['GETRANGE', name, '0', '15'])
    const count = await hyperLogLogCount(client, name, encoding, head)
    if (count !== undefined) return hyperLogLogResult(base, count)
    return readBitmap(client, name, base, offset)
  }
  const raw = await send(client, ['GET', name])
  const count = await hyperLogLogCount(client, name, encoding, raw)
  if (count !== undefined) return hyperLogLogResult(base, count)
  return { ...base, keyType: 'string', value: encodeReply(raw), more: false }
}
async function hyperLogLogCount(client, name, encoding, raw) {
  if (encoding !== 'hyperloglog' && !looksLikeHyperLogLog(raw)) return undefined
  try { return await send(client, ['PFCOUNT', name]) }
  catch (error) {
    if (encoding === 'hyperloglog') throw error
    return undefined
  }
}
function hyperLogLogResult(base, count) {
  const countText = text(count)
  return { ...base, keyType: 'hyperloglog', value: encodeReply(count), card: { count: countText }, more: false }
}
async function readBitmap(client, name, base, offset) {
  const total = Number(text(await send(client, ['STRLEN', name]))) * 8
  const count = Math.min(PAGE, Math.max(0, total - offset))
  const bits = count ? await readBits(client, name, offset, count) : []
  return {
    ...base, keyType: 'bitmap', value: encodeReply(null), more: offset + count < total && count === PAGE,
    rows: bits.map((bit, index) => ({ id: String(offset + index), cells: { offset: String(offset + index), bit } })),
  }
}
async function readBits(client, name, start, count) {
  const bits = []
  for (let at = 0; at < count;) {
    const size = Math.min(80, count - at)
    const args = ['BITFIELD', name]
    for (let index = 0; index < size; index += 1) args.push('GET', 'u1', String(start + at + index))
    const reply = await send(client, args)
    const values = Array.isArray(reply) ? reply : [reply]
    for (const item of values) bits.push(text(item) === '1' ? '1' : '0')
    at += size
  }
  return bits
}
async function readList(client, name, base, offset) {
  const reply = await send(client, ['LRANGE', name, String(offset), String(offset + PAGE - 1)])
  const items = Array.isArray(reply) ? reply : []
  const more = offset + PAGE < Number(text(await send(client, ['LLEN', name])))
  return {
    ...base, keyType: 'list', value: encodeReply(reply), more,
    rows: items.map((item, index) => ({ id: String(offset + index + 1), cells: { index: String(offset + index), value: cellText(item) } })),
  }
}
async function readMembers(client, name, type, base, cursor) {
  const op = type === 'hash' ? 'HSCAN' : type === 'set' ? 'SSCAN' : 'ZSCAN'
  const page = cursorReply(await send(client, [op, name, cursor, 'COUNT', String(PAGE)]))
  const more = page.cursor !== '0'
  if (type === 'set') {
    return {
      ...base, keyType: 'set', value: encodeReply(new Set(page.values)), cursor: page.cursor, more,
      rows: page.values.map((item, index) => ({ id: String(index + 1), cells: { member: cellText(item) } })),
    }
  }
  const pairs = Array.from({ length: Math.floor(page.values.length / 2) }, (_, index) => [page.values[index * 2], page.values[index * 2 + 1]])
  if (type === 'hash') {
    const fields = pairs.map(pair => cellText(pair[0]))
    const ttls = await hashTtls(client, name, fields)
    return {
      ...base, keyType: 'hash', value: encodeReply(new Map(pairs)), cursor: page.cursor, more,
      rows: pairs.map((pair, index) => ({ id: String(index + 1), cells: { field: cellText(pair[0]), value: cellText(pair[1]), ttl: ttls[index] ?? '-1' } })),
    }
  }
  const geo = await geoRows(client, name, pairs)
  return {
    ...base, keyType: geo ? 'geo' : 'zset', value: encodeReply(new Map(pairs)), cursor: page.cursor, more,
    rows: geo ?? pairs.map((pair, index) => ({ id: String(index + 1), cells: { member: cellText(pair[0]), score: cellText(pair[1]) } })),
  }
}
async function hashTtls(client, name, fields) {
  if (!fields.length) return []
  try {
    const reply = await send(client, ['HTTL', name, 'FIELDS', String(fields.length), ...fields])
    if (!Array.isArray(reply)) return fields.map(() => '-1')
    return fields.map((_, index) => reply[index] === undefined ? '-1' : text(reply[index]))
  } catch (error) {
    if (commandMissing(error) || /参数无效/.test(String(error instanceof Error ? error.message : error))) return fields.map(() => '-1')
    throw error
  }
}
async function geoRows(client, name, pairs) {
  if (!pairs.length) return undefined
  const member = cellText(pairs[0][0])
  if (!member || member.startsWith('(binary')) return undefined
  const score = Number(cellText(pairs[0][1]))
  const probed = await optionalCommand(client, ['GEOPOS', name, member])
  if (probed === undefined) return undefined
  const position = positionOf(probed)
  if (!position || !isGeoScore(score, position[0], position[1])) return undefined
  const members = pairs.map(pair => cellText(pair[0]))
  const located = await send(client, ['GEOPOS', name, ...members])
  const positions = Array.isArray(located) ? located : []
  return pairs.map((pair, index) => {
    const spot = Array.isArray(positions[index]) ? positions[index] : []
    return { id: String(index + 1), cells: { member: cellText(pair[0]), lon: spot[0] == null ? '' : text(spot[0]), lat: spot[1] == null ? '' : text(spot[1]) } }
  })
}
async function readStream(client, name, base, cursor) {
  const start = cursor ? `(${cursor}` : '-'
  const reply = await send(client, ['XRANGE', name, start, '+', 'COUNT', String(PAGE)])
  const entries = Array.isArray(reply) ? reply : []
  const last = entries.at(-1)
  return {
    ...base, keyType: 'stream', value: encodeReply(reply), more: entries.length === PAGE, ...(last ? { cursor: cellText(last[0]) } : {}),
    rows: entries.map(entry => {
      const id = cellText(Array.isArray(entry) ? entry[0] : '')
      const fields = streamFields(Array.isArray(entry) ? entry[1] : [])
      return { id, cells: { id, fields } }
    }),
  }
}
function streamFields(pairs) {
  if (!Array.isArray(pairs)) return ''
  const lines = []
  for (let index = 0; index + 1 < pairs.length; index += 2) lines.push(`${cellText(pairs[index])}=${cellText(pairs[index + 1])}`)
  return lines.join('\n')
}
async function readSeries(client, name, base, cursor) {
  const start = cursor === '0' ? '-' : `(${cursor}`
  const reply = await send(client, ['TS.RANGE', name, start, '+', 'COUNT', String(PAGE)])
  const entries = Array.isArray(reply) ? reply : []
  const last = entries.at(-1)
  return {
    ...base, keyType: 'timeseries', value: encodeReply(reply), more: entries.length === PAGE, ...(Array.isArray(last) ? { cursor: cellText(last[0]) } : {}),
    rows: entries.map((entry, index) => {
      const pair = Array.isArray(entry) ? entry : []
      return { id: String(index + 1), cells: { time: cellText(pair[0]), value: cellText(pair[1]) } }
    }),
  }
}
function configField(reply, name) {
  if (reply instanceof Map) {
    for (const [key, value] of reply) if (text(key).toLowerCase() === name) return text(value)
    return ''
  }
  if (Array.isArray(reply)) {
    for (let index = 0; index + 1 < reply.length; index += 2) if (text(reply[index]).toLowerCase() === name) return text(reply[index + 1])
    return ''
  }
  if (reply && typeof reply === 'object') {
    for (const [key, value] of Object.entries(reply)) if (key.toLowerCase() === name) return text(value)
  }
  return ''
}
const DATABASE_LIST_CAP = 128
async function databases(client, input) {
  try {
    if (redisModeOf(input) === 'cluster') return ['0']
    let configured = 0
    try {
      const parsed = Number(configField(await send(client, ['CONFIG', 'GET', 'databases']), 'databases'))
      if (Number.isInteger(parsed) && parsed >= 1) configured = Math.min(parsed, DATABASE_LIST_CAP)
    } catch { /* ACL may deny CONFIG */ }
    let highest = 0
    const current = Number(input?.database)
    if (Number.isInteger(current) && current >= 0 && current < DATABASE_LIST_CAP) highest = current
    try {
      const info = text(await send(client, ['INFO', 'keyspace']))
      for (const match of info.matchAll(/^db(\d+):/gm)) {
        const index = Number(match[1])
        if (index >= 0 && index < DATABASE_LIST_CAP) highest = Math.max(highest, index)
      }
    } catch { /* INFO may be denied */ }
    const count = Math.min(DATABASE_LIST_CAP, Math.max(configured || 16, highest + 1, 1))
    return Array.from({ length: count }, (_, index) => String(index))
  } catch {
    const current = String(input?.database ?? '0')
    return /^(0|[1-9]\d{0,4})$/.test(current) ? [current] : ['0']
  }
}
async function probe(client, input) {
  await send(client, ['PING'])
  let version = 'Redis'
  try { version = `Redis ${text(await send(client, ['INFO', 'server'])).match(/^redis_version:(.+)$/m)?.[1]?.trim() || ''}`.trim() }
  catch { /* INFO may be denied by ACL */ }
  return { version, database: String(input.database), databases: [] }
}

export const redisProvider = Object.freeze({
  id: 'redis', family: 'redis', capabilities: Object.freeze({ command: true, scan: true, key: true }),
  runtime: redisRuntime,
  connection: {
    validateTarget(database, input) { assertRedisTarget(database, input) },
    fingerprintSuffix(_mode, input) {
      const mode = input?.redisMode === 'sentinel' || input?.redisMode === 'cluster' ? input.redisMode : 'standalone'
      return [input?.tls ? 'tls' : 'plain', input?.caPem || '', mode, ...(mode === 'sentinel' ? [String(input?.sentinelMaster || '').trim()] : [])]
    },
  },
  driver: { open, close, probe, databases, execute: send, scan, suggestKeys, key, revive: open, commandCredentials },
  recovery: Object.freeze({ replayCommands: false, uncertainOnInterruption: true }),
})

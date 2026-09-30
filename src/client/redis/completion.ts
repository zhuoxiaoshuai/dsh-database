import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { REDIS_HELP, REDIS_OPTION_HELP, REDIS_SUBCOMMAND_HELP } from './help.ts'

type CommandSpec = { usage: string; subcommands?: readonly string[]; optionsFrom?: number; options?: readonly string[] }

/** UI hints only. This is neither a Redis command allowlist nor an authorization rule. */
export const COMMANDS: Record<string, CommandSpec> = {
  ACL: { usage: 'ACL <subcommand> [arguments]', subcommands: ['CAT', 'GETUSER', 'LIST', 'USERS', 'WHOAMI'] },
  AUTH: { usage: 'AUTH [username] password' },
  CLIENT: { usage: 'CLIENT <subcommand> [arguments]', subcommands: ['GETNAME', 'ID', 'INFO', 'LIST', 'SETNAME'] },
  CONFIG: { usage: 'CONFIG <subcommand> [arguments]', subcommands: ['GET', 'SET', 'RESETSTAT', 'REWRITE'] },
  DBSIZE: { usage: 'DBSIZE' },
  DECR: { usage: 'DECR key' },
  DEL: { usage: 'DEL key [key ...]' },
  ECHO: { usage: 'ECHO message' },
  EVAL: { usage: 'EVAL script numkeys [key ...] [arg ...]' },
  EXISTS: { usage: 'EXISTS key [key ...]' },
  EXPIRE: { usage: 'EXPIRE key seconds [NX | XX | GT | LT]', optionsFrom: 3, options: ['NX', 'XX', 'GT', 'LT'] },
  FLUSHALL: { usage: 'FLUSHALL [ASYNC | SYNC]', optionsFrom: 1, options: ['ASYNC', 'SYNC'] },
  FLUSHDB: { usage: 'FLUSHDB [ASYNC | SYNC]', optionsFrom: 1, options: ['ASYNC', 'SYNC'] },
  GET: { usage: 'GET key' },
  HDEL: { usage: 'HDEL key field [field ...]' },
  HGET: { usage: 'HGET key field' },
  HGETALL: { usage: 'HGETALL key' },
  HSCAN: { usage: 'HSCAN key cursor [MATCH pattern] [COUNT count]', optionsFrom: 3, options: ['MATCH', 'COUNT'] },
  HSET: { usage: 'HSET key field value [field value ...]' },
  INCR: { usage: 'INCR key' },
  INFO: { usage: 'INFO [section]', optionsFrom: 1, options: ['SERVER', 'CLIENTS', 'MEMORY', 'PERSISTENCE', 'STATS', 'REPLICATION', 'CPU', 'KEYSPACE'] },
  LPOP: { usage: 'LPOP key [count]' },
  LPUSH: { usage: 'LPUSH key element [element ...]' },
  LRANGE: { usage: 'LRANGE key start stop' },
  LSET: { usage: 'LSET key index element' },
  MEMORY: { usage: 'MEMORY <subcommand> [arguments]', subcommands: ['DOCTOR', 'STATS', 'USAGE'] },
  MGET: { usage: 'MGET key [key ...]' },
  MSET: { usage: 'MSET key value [key value ...]' },
  OBJECT: { usage: 'OBJECT <subcommand> key', subcommands: ['ENCODING', 'FREQ', 'IDLETIME', 'REFCOUNT'] },
  PERSIST: { usage: 'PERSIST key' },
  PING: { usage: 'PING [message]' },
  PTTL: { usage: 'PTTL key' },
  RPOP: { usage: 'RPOP key [count]' },
  RPUSH: { usage: 'RPUSH key element [element ...]' },
  SADD: { usage: 'SADD key member [member ...]' },
  SCAN: { usage: 'SCAN cursor [MATCH pattern] [COUNT count] [TYPE type]', optionsFrom: 2, options: ['MATCH', 'COUNT', 'TYPE'] },
  SCRIPT: { usage: 'SCRIPT <subcommand> [arguments]', subcommands: ['EXISTS', 'FLUSH', 'LOAD'] },
  SELECT: { usage: 'SELECT index' },
  SET: { usage: 'SET key value [NX | XX] [EX seconds | PX milliseconds] [GET | KEEPTTL]', optionsFrom: 3, options: ['NX', 'XX', 'EX', 'PX', 'EXAT', 'PXAT', 'GET', 'KEEPTTL'] },
  SMEMBERS: { usage: 'SMEMBERS key' },
  SREM: { usage: 'SREM key member [member ...]' },
  SSCAN: { usage: 'SSCAN key cursor [MATCH pattern] [COUNT count]', optionsFrom: 3, options: ['MATCH', 'COUNT'] },
  TTL: { usage: 'TTL key' },
  TYPE: { usage: 'TYPE key' },
  UNLINK: { usage: 'UNLINK key [key ...]' },
  ZADD: { usage: 'ZADD key [NX | XX | GT | LT] [CH] [INCR] score member [score member ...]', optionsFrom: 2, options: ['NX', 'XX', 'GT', 'LT', 'CH', 'INCR'] },
  ZRANGE: { usage: 'ZRANGE key start stop [BYSCORE | BYLEX] [REV] [LIMIT offset count] [WITHSCORES]', optionsFrom: 4, options: ['BYSCORE', 'BYLEX', 'REV', 'LIMIT', 'WITHSCORES'] },
  ZREM: { usage: 'ZREM key member [member ...]' },
  ZSCAN: { usage: 'ZSCAN key cursor [MATCH pattern] [COUNT count]', optionsFrom: 3, options: ['MATCH', 'COUNT'] },
}

type KeySlots = 'first' | 'all' | 'pairs' | readonly number[]
const KEY_SLOTS: Record<string, KeySlots> = {
  DECR: 'first', DEL: 'all', EXISTS: 'all', EXPIRE: 'first', GET: 'first',
  HDEL: 'first', HGET: 'first', HGETALL: 'first', HSCAN: 'first', HSET: 'first',
  INCR: 'first', LPOP: 'first', LPUSH: 'first', LRANGE: 'first', LSET: 'first',
  MEMORY: [2], MGET: 'all', MSET: 'pairs', OBJECT: [2], PERSIST: 'first', PTTL: 'first',
  RPOP: 'first', RPUSH: 'first', SADD: 'first', SET: 'first', SMEMBERS: 'first',
  SREM: 'first', SSCAN: 'first', TTL: 'first', TYPE: 'first', UNLINK: 'all',
  ZADD: 'first', ZRANGE: 'first', ZREM: 'first', ZSCAN: 'first',
}

type Token = { start: number; end: number; value: string; quoted: boolean }

/** Tolerant prefix lexer: an unfinished quote or escape must never block a hint. */
function tokensOf(text: string): Token[] | null {
  if (/[\r\n]/.test(text)) return null
  const tokens: Token[] = []
  let start = -1, value = '', quote = '', escaped = false, quoted = false
  const push = (end: number) => {
    if (start >= 0) tokens.push({ start, end, value, quoted: quoted || !!quote || escaped })
    start = -1; value = ''; quote = ''; escaped = false; quoted = false
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (start < 0 && !/\s/.test(char)) start = i
    if (escaped) { value += char; escaped = false; continue }
    if (char === '\\') { escaped = true; quoted = true; continue }
    if (quote) { if (char === quote) quote = ''; else value += char; continue }
    if (char === '"' || char === "'") { quote = char; quoted = true; continue }
    if (/\s/.test(char)) { push(i); continue }
    value += char
  }
  push(text.length)
  return tokens
}

function decodeRaw(raw: string): string {
  let value = '', quote = '', escaped = false
  for (const char of raw) {
    if (escaped) { value += char === 'n' ? '\n' : char === 'r' ? '\r' : char === 't' ? '\t' : char; escaped = false; continue }
    if (char === '\\') { escaped = true; continue }
    if (quote) { if (char === quote) quote = ''; else value += char; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    value += char
  }
  return value
}

function slotAt(tokens: Token[], pos: number, text: string): { index: number; from: number; to: number; typed: string; quoted: boolean } {
  const active = tokens.findIndex(token => token.start <= pos && pos <= token.end)
  if (active >= 0) {
    const token = tokens[active]
    return { index: active, from: token.start, to: token.end, typed: decodeRaw(text.slice(token.start, pos)), quoted: token.quoted }
  }
  return { index: tokens.filter(token => token.end < pos).length, from: pos, to: pos, typed: '', quoted: false }
}

const VALUE_OPTIONS = new Set(['MATCH', 'COUNT', 'TYPE', 'EX', 'PX', 'EXAT', 'PXAT', 'LIMIT'])

export function redisKeySlot(text: string, pos: number): { prefix: string; from: number; to: number } | null {
  const tokens = tokensOf(text)
  if (!tokens || pos < 0 || pos > text.length) return null
  const slot = slotAt(tokens, pos, text)
  const command = tokens[0]?.value.toUpperCase() || ''
  const rule = KEY_SLOTS[command]
  if (!rule || slot.index < 1) return null
  if (command === 'MEMORY' && tokens[1]?.value.toUpperCase() !== 'USAGE') return null
  const isKey = rule === 'first' ? slot.index === 1 : rule === 'all' ? true : rule === 'pairs' ? slot.index % 2 === 1 : rule.includes(slot.index)
  return isKey ? { prefix: slot.typed, from: slot.from, to: slot.to } : null
}

export function encodeRedisKey(key: string): string | null {
  if (!key || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(key)) return null
  if (!/[\s"'\\]/.test(key)) return key
  return '"' + key.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"'
}

function keyOptions(keys: readonly string[], prefix: string, cached: boolean): Completion[] {
  return [...new Set(keys)].filter(key => key.startsWith(prefix)).slice(0, 30).flatMap(key => {
    const apply = encodeRedisKey(key)
    return apply === null ? [] : [{ label: key, apply, type: 'key', detail: cached ? '本页已扫描' : '本次限量扫描', info: '这是 Redis Key 名称。选中后只填写命令参数，不会执行命令。', boost: cached ? 10 : 0 }]
  })
}

export function redisCompletionAt(text: string, pos: number, explicit = false, keys: readonly string[] = []): CompletionResult | null {
  const tokens = tokensOf(text)
  if (!tokens || pos < 0 || pos > text.length) return null
  const slot = slotAt(tokens, pos, text)
  const keySlot = redisKeySlot(text, pos)
  if (keySlot) {
    if (!keySlot.prefix && !explicit) return null
    const options = keyOptions(keys, keySlot.prefix, true)
    return options.length ? { from: keySlot.from, to: keySlot.to, options, filter: false } : null
  }
  if (slot.quoted || (!slot.typed && !explicit)) return null
  const command = tokens[0]?.value.toUpperCase() || ''
  const spec = COMMANDS[command]
  let candidates: readonly string[] = [], type = 'argument'
  if (slot.index === 0) { candidates = Object.keys(COMMANDS); type = 'command' }
  else if (slot.index === 1 && spec?.subcommands) candidates = spec.subcommands
  else if (spec?.optionsFrom !== undefined && slot.index >= spec.optionsFrom && !VALUE_OPTIONS.has(tokens[slot.index - 1]?.value.toUpperCase() || '')) candidates = spec.options || []
  const typed = slot.typed.toUpperCase()
  const options: Completion[] = candidates.filter(value => value.startsWith(typed)).map(value => {
    const help = REDIS_HELP[value]
    const description = type === 'command' ? help?.summary : slot.index === 1 && spec?.subcommands ? REDIS_SUBCOMMAND_HELP[command]?.[value] : REDIS_OPTION_HELP[command]?.[value]
    return {
      label: value, apply: value, type, detail: description || 'Redis 参数',
      info: type === 'command' && help
        ? `用途：${help.summary}\n用法：${COMMANDS[value].usage}\n参数：${help.parameters}\n返回：${help.result}\n示例：${help.example}`
        : `用途：${description || 'Redis 参数。'}\n用法：${spec?.usage || command}\n参数：${REDIS_HELP[command]?.parameters || '请参照当前命令的参数位置。'}\n返回：${REDIS_HELP[command]?.result || '由命令决定。'}\n所属命令示例：${REDIS_HELP[command]?.example || command}`,
    }
  })
  return options.length ? { from: slot.from, to: slot.to, options, filter: false } : null
}

export function redisParameterHint(text: string): string | undefined {
  const tokens = tokensOf(text)
  if (!tokens?.length) return undefined
  const help = REDIS_HELP[tokens[0].value.toUpperCase()]
  return help ? `${help.summary} 参数：${help.parameters}` : undefined
}

export function createRedisCompletionSource(getKeys: () => readonly string[] = () => []) {
  return (context: CompletionContext): CompletionResult | null => redisCompletionAt(context.state.doc.toString(), context.pos, context.explicit, getKeys())
}

export function redisRemoteKeyCompletion(text: string, pos: number, keys: readonly string[]): CompletionResult | null {
  const slot = redisKeySlot(text, pos)
  if (!slot) return null
  const options = keyOptions(keys, slot.prefix, false)
  return options.length ? { from: slot.from, to: slot.to, options, filter: false } : null
}

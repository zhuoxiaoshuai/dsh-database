import test from 'node:test'
import assert from 'node:assert/strict'
import { COMMANDS, encodeRedisKey, redisCompletionAt, redisKeySlot, redisParameterHint, redisRemoteKeyCompletion } from '../src/client/redis/completion.ts'
import { REDIS_HELP, REDIS_OPTION_HELP, REDIS_SUBCOMMAND_HELP } from '../src/client/redis/help.ts'
import { parseRedisCommand } from '../src/shared/redis-command.ts'

test('Redis command and subcommand completion replaces only the current token', () => {
  const command = redisCompletionAt('pi', 2)
  assert.ok(command.options.some(item => item.label === 'PING'))
  assert.equal(command.from, 0)
  assert.equal(command.to, 2)
  const middle = redisCompletionAt('SET key value', 2, true)
  assert.ok(middle.options.some(item => item.label === 'SET'))
  assert.equal(middle.from, 0)
  assert.equal(middle.to, 3)
  const subcommand = redisCompletionAt('CONFIG GE', 9)
  assert.ok(subcommand.options.some(item => item.label === 'GET'))
  assert.equal(subcommand.from, 7)
  assert.equal(subcommand.to, 9)
})

test('Redis fixed arguments are offered while free values are only hinted', () => {
  assert.ok(redisCompletionAt('SET key value N', 15)?.options.some(item => item.label === 'NX'))
  assert.ok(redisCompletionAt('SCAN 0 MA', 9)?.options.some(item => item.label === 'MATCH'))
  assert.equal(redisCompletionAt('GET ', 4, true), null)
  assert.match(redisParameterHint('GET '), /读取一个.*参数：写一个 Key/)
  assert.match(redisParameterHint('SET key "unfinished'), /写入或覆盖.*参数：先写 Key 和值/)
  assert.equal(redisCompletionAt('GET mykey', 9), null)
  assert.equal(redisParameterHint('SOMENEWCOMMAND x'), undefined)
})

test('every listed Redis command, subcommand and fixed option has Chinese help', () => {
  assert.deepEqual(Object.keys(REDIS_HELP).sort(), Object.keys(COMMANDS).sort())
  for (const [name, spec] of Object.entries(COMMANDS)) {
    const help = REDIS_HELP[name]
    for (const field of ['summary', 'parameters', 'result', 'example']) assert.ok(help[field]?.length > 3, `${name} ${field}`)
    const option = redisCompletionAt(name.slice(0, 2), 2)?.options.find(item => item.label === name)
    assert.match(option?.info || '', /用途：.*参数：.*返回：.*示例：/s)
    for (const sub of spec.subcommands || []) assert.ok(REDIS_SUBCOMMAND_HELP[name]?.[sub], `${name} ${sub}`)
    for (const fixed of spec.options || []) assert.ok(REDIS_OPTION_HELP[name]?.[fixed], `${name} ${fixed}`)
  }
  assert.match(REDIS_HELP.FLUSHALL.summary, /所有 DB/)
})

test('Key slots are declared rather than guessed, including repeated and alternating arguments', () => {
  for (const [value, pos] of [['GET my', 6], ['SET my value', 6], ['DEL one my', 10], ['MGET one my', 11], ['MSET one value my two', 17], ['MEMORY USAGE my', 15], ['OBJECT ENCODING my', 18]]) {
    assert.equal(redisKeySlot(value, pos)?.prefix, 'my', value)
  }
  for (const value of ['HGET hash field', 'HSET hash field value', 'SCAN 0 MATCH prefix', 'SET key value', 'MSET one value', 'MEMORY STATS my', 'FUTURE my']) {
    assert.equal(redisKeySlot(value, value.length), null, value)
  }
})

test('cached and remote Key completion replaces only the active argument and roundtrips quotes', () => {
  const result = redisCompletionAt('GET ca', 6, false, ['cache:one', 'cache:two', 'other'])
  assert.deepEqual(result.options.map(item => item.label), ['cache:one', 'cache:two'])
  assert.equal(result.from, 4)
  assert.equal(result.to, 6)
  const middle = redisCompletionAt('MGET ca tail', 7, false, ['cache:one'])
  assert.equal(middle.from, 5)
  assert.equal(middle.to, 7)
  assert.equal(redisRemoteKeyCompletion('GET ca', 6, ['cache:remote'])?.options[0].detail, '本次限量扫描')
  for (const key of ['space key', 'quote"key', "single'key", 'slash\\key', 'a\nb']) {
    const encoded = encodeRedisKey(key)
    assert.equal(parseRedisCommand(`GET ${encoded}`)[1], key)
  }
  assert.equal(encodeRedisKey('\u0000bad'), null)
  assert.equal(encodeRedisKey('\ufffdbad'), null)
  assert.equal(redisCompletionAt('GET ', 4, true, ['space key'])?.options[0].apply, '"space key"')
})

test('Redis completion tolerates quotes and escapes without changing execution rules', () => {
  assert.equal(redisCompletionAt('SET "key with spaces" value N', 29)?.options[0]?.label, 'NX')
  assert.equal(redisCompletionAt('CONFIG "GE', 10), null)
  assert.equal(redisCompletionAt('CONFIG GE\\', 10), null)
  assert.equal(redisCompletionAt('GET key\nDEL key', 4), null)
})

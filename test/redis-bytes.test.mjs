import test from 'node:test'
import assert from 'node:assert/strict'
import { byteLengthOf, displayBytes, encodeTextBytes, fromBytesString, isBytesString, parseBytes, toBytesString } from '../src/shared/redis-bytes.ts'
import { parseRedisCommand, parseRedisCommandArgs } from '../src/shared/redis-command.ts'

const bytesOf = (...values) => String.fromCharCode(...values)

test('displayBytes keeps readable UTF-8 and escapes every other byte', () => {
  // 中文 Key 保持原样
  assert.equal(displayBytes(bytesOf(0xe4, 0xb8, 0xad)), '中')
  assert.equal(displayBytes('app:order:1'), 'app:order:1')
  // Java 序列化前缀逐字节转义
  assert.equal(displayBytes(bytesOf(0xac, 0xed, 0x00, 0x05) + 'java'), '\\xAC\\xED\\x00\\x05java')
  // 合法 UTF-8 但含控制字符时也要转义
  assert.equal(displayBytes(bytesOf(0x00) + 'abc'), '\\x00abc')
  // U+0080 必须保留两个字节，否则回写会变成单字节 0x80
  assert.equal(displayBytes(bytesOf(0xc2, 0x80)), '\\xC2\\x80')
  // 字面反斜杠要转义，才能与 \xNN 区分
  assert.equal(displayBytes('a\\xAC'), 'a\\\\xAC')
})

test('parseBytes inverts displayBytes for text, binary and control bytes', () => {
  const binary = [
    bytesOf(0x00, 0x01), bytesOf(0xac, 0xed, 0x00, 0x05) + 'com.x.Y',
    bytesOf(0xc2, 0x80), bytesOf(0x7f), bytesOf(0x61, 0x5c, 0x78, 0x41, 0x43),
  ]
  const texts = ['abc', '中文', 'app:order:1', 'a:b', 'C:\\temp', '\\x41']
  for (const sample of [...binary, ...texts.map(encodeTextBytes)]) {
    assert.equal(parseBytes(displayBytes(sample)), sample, `roundtrip ${JSON.stringify(sample)}`)
  }
})

test('parseBytes only interprets \\xNN and \\\\ so Windows paths survive', () => {
  assert.equal(parseBytes('C:\\temp'), 'C:\\temp')
  assert.equal(parseBytes('\\x41'), 'A')
  assert.equal(parseBytes('\\\\x41'), '\\x41')
  assert.throws(() => parseBytes('\\xZZ'), /两位十六进制/)
})

test('byte helpers reject non-byte input instead of truncating it', () => {
  assert.equal(isBytesString('中文'), false)
  assert.equal(isBytesString(bytesOf(0xe4, 0xb8, 0xad)), true)
  assert.equal(byteLengthOf(bytesOf(0xe4, 0xb8, 0xad)), 3)
  assert.throws(() => fromBytesString('中文'), /编码无效/)
  assert.equal(toBytesString(Uint8Array.from([0xac, 0xed])), bytesOf(0xac, 0xed))
})

test('command parser marks hexadecimal arguments as bytes', () => {
  const parsed = parseRedisCommandArgs('GET "\\xac\\xed\\x00\\x05java"')
  assert.deepEqual(parsed.map(arg => arg.value), ['GET', bytesOf(0xac, 0xed, 0x00, 0x05) + 'java'])
  assert.deepEqual(parsed.map(arg => arg.bytes), [false, true])
  // 普通文本参数仍然是文本
  assert.deepEqual(parseRedisCommandArgs('SET k 中文').map(arg => arg.bytes), [false, false, false])
  // 命令名禁止转义，防止绕过 AUTH 检测
  assert.throws(() => parseRedisCommandArgs('"\\x41UTH" x'), /命令名不支持十六进制转义/)
  assert.throws(() => parseRedisCommandArgs('GET \\xZ'), /两位十六进制/)
  assert.deepEqual(parseRedisCommand('SET k \\x00'), ['SET', 'k', bytesOf(0x00)])
})

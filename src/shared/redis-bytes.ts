/**
 * Redis Key / member 的字节表示工具。
 *
 * 不变式：bytes 串是 JS 字符串，每个字符的码点都在 0x00–0xFF 之间，与字节 1:1 映射；
 * 因此 Redis 里的任意字节（含 Java 序列化前缀 AC ED 00 05）都能无损往返。
 * 展示串是转义形式（\xAC\xED\x00\x05xxx），可读、可复制回命令台，并且与 bytes 串单射对应。
 */

const encoder = new TextEncoder()
const strictDecoder = new TextDecoder('utf-8', { fatal: true })
const HEX = /^[0-9a-fA-F]{2}$/
const CHUNK = 4096

/** 是否所有字符码点都落在 0x00–0xFF（即这是一个 bytes 串而非普通文本）。 */
export function isBytesString(value: string): boolean {
  if (typeof value !== 'string') return false
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) > 0xff) return false
  }
  return true
}

/** bytes 串的字节数就是字符数。 */
export function byteLengthOf(value: string): number {
  return value.length
}

/** 字节数组 → bytes 串。 */
export function toBytesString(bytes: Uint8Array): string {
  let text = ''
  for (let index = 0; index < bytes.length; index += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(index, index + CHUNK))
  }
  return text
}

/** bytes 串 → 字节数组；含 0xFF 以上码点说明调用方传错了通道，直接报错而不是静默截断。 */
export function fromBytesString(value: string): Uint8Array {
  if (!isBytesString(value)) throw new Error('Key 编码无效：不是字节串。')
  const bytes = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index++) bytes[index] = value.charCodeAt(index)
  return bytes
}

/** 文本按 UTF-8 编码成 bytes 串（中文 key 的入口）。 */
export function encodeTextBytes(value: string): string {
  return toBytesString(encoder.encode(value))
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return strictDecoder.decode(bytes)
  } catch {
    return null
  }
}

function isDisplayableText(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return false
  }
  return true
}

/**
 * bytes 串 → 展示串。
 * 合法 UTF-8 且无控制字符时原样显示（中文 key 保持原样），否则逐字节转义，
 * 保证 parseBytes(displayBytes(x)) === x。
 */
export function displayBytes(value: string): string {
  const bytes = fromBytesString(value)
  const decoded = decodeUtf8(bytes)
  if (decoded !== null && isDisplayableText(decoded)) return decoded.replace(/\\/g, '\\\\')
  let text = ''
  for (const byte of bytes) {
    if (byte === 0x5c) text += '\\\\'
    else if (byte >= 0x20 && byte <= 0x7e) text += String.fromCharCode(byte)
    else text += '\\x' + byte.toString(16).toUpperCase().padStart(2, '0')
  }
  return text
}

/**
 * 展示串 / 用户文本 → bytes 串。
 * 只解释 \xNN 与 \\，其余反斜杠按字面保留，这样 "C:\temp" 不会被当成制表符。
 */
export function parseBytes(value: string): string {
  let text = ''
  let index = 0
  while (index < value.length) {
    const char = value[index]
    if (char === '\\') {
      const next = value[index + 1]
      if (next === 'x' || next === 'X') {
        const hex = value.slice(index + 2, index + 4)
        if (!HEX.test(hex)) throw new Error('十六进制转义需要两位十六进制数字。')
        text += String.fromCharCode(parseInt(hex, 16))
        index += 4
        continue
      }
      if (next === '\\') {
        text += '\\'
        index += 2
        continue
      }
      text += '\\'
      index += 1
      continue
    }
    const code = value.codePointAt(index) ?? 0
    const current = String.fromCodePoint(code)
    text += code < 0x80 ? current : encodeTextBytes(current)
    index += current.length
  }
  return text
}

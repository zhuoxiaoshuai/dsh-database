/** Redis CLI style single command parser. No shell expansion or command chaining. */

export interface RedisArg {
  /** 参数值。带 \xNN 转义时是按 latin1 存储的字节串，发送时需还原成 Buffer。 */
  value: string
  /** 该参数是否出现过 \xNN 转义。 */
  bytes: boolean
}

/** 解析成带字节标记的参数列表，供命令执行按标记还原二进制参数。 */
export function parseRedisCommandArgs(command: string): RedisArg[] {
  if (typeof command !== 'string' || BufferByteLength(command) > 65536) throw new Error('Redis 命令超过 64 KiB。')
  const args: RedisArg[] = []
  let token = '', quote = '', started = false, escaped = false, tokenBytes = false
  let index = 0
  while (index < command.length) {
    const char = command[index]
    if (escaped) {
      if (char === 'x' || char === 'X') {
        const hex = command.slice(index + 1, index + 3)
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error('十六进制转义需要两位十六进制数字。')
        token += String.fromCharCode(parseInt(hex, 16))
        tokenBytes = true
        escaped = false; started = true
        index += 3
        continue
      }
      token += char === 'n' ? '\n' : char === 'r' ? '\r' : char === 't' ? '\t' : char
      escaped = false; started = true; index += 1; continue
    }
    if (char === '\\') { escaped = true; started = true; index += 1; continue }
    if (quote) {
      if (char === quote) quote = ''
      else token += char
      index += 1; continue
    }
    if (char === '"' || char === "'") { quote = char; started = true; index += 1; continue }
    if (char === '\n' || char === '\r') throw new Error('每次只能提交一条 Redis 命令。')
    if (/\s/.test(char)) {
      if (started) { args.push({ value: token, bytes: tokenBytes }); token = ''; started = false; tokenBytes = false }
      index += 1; continue
    }
    token += char; started = true; index += 1
  }
  if (escaped || quote) throw new Error('命令中的引号或转义未结束。')
  if (started) args.push({ value: token, bytes: tokenBytes })
  if (!args.length || args.length > 256 || !args[0].value) throw new Error('请输入一条 Redis 命令。')
  // 命令名必须明文：否则 "\x41UTH" 之类会绕过凭据识别与黑名单。
  if (args[0].bytes) throw new Error('命令名不支持十六进制转义。')
  return args
}

export function parseRedisCommand(command: string): string[] {
  return parseRedisCommandArgs(command).map(arg => arg.value)
}

function BufferByteLength(value: string): number { return new TextEncoder().encode(value).length }

export function redisCommandContainsCredential(args: readonly string[]): boolean {
  const command = args[0]?.toUpperCase()
  const sub = args[1]?.toUpperCase()
  return command === 'AUTH' || (command === 'HELLO' && args.some(arg => arg.toUpperCase() === 'AUTH'))
    || (command === 'ACL' && sub === 'SETUSER') || (command === 'CONFIG' && sub === 'SET' && args[2]?.toLowerCase() === 'requirepass')
    || (command === 'MIGRATE' && args.some(arg => ['AUTH', 'AUTH2'].includes(arg.toUpperCase())))
}

export function redisCommandTextMayContainCredential(text: string): boolean {
  try { return redisCommandContainsCredential(parseRedisCommand(text)) }
  catch { return /^\s*(?:AUTH\b|HELLO\b[^\r\n]*\bAUTH\b|ACL\s+SETUSER\b|CONFIG\s+SET\s+requirepass\b|MIGRATE\b[^\r\n]*\bAUTH2?\b)/i.test(text) }
}

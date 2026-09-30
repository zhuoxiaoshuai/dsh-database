/** Redis CLI style single command parser. No shell expansion or command chaining. */
export function parseRedisCommand(command: string): string[] {
  if (typeof command !== 'string' || BufferByteLength(command) > 65536) throw new Error('Redis 命令超过 64 KiB。')
  const args: string[] = []
  let token = '', quote = '', started = false, escaped = false
  for (const char of command) {
    if (escaped) {
      if (char === 'x') throw new Error('首版命令台不支持十六进制字节转义。')
      token += char === 'n' ? '\n' : char === 'r' ? '\r' : char === 't' ? '\t' : char
      escaped = false; started = true; continue
    }
    if (char === '\\') { escaped = true; started = true; continue }
    if (quote) { if (char === quote) quote = ''; else token += char; continue }
    if (char === '"' || char === "'") { quote = char; started = true; continue }
    if (char === '\n' || char === '\r') throw new Error('每次只能提交一条 Redis 命令。')
    if (/\s/.test(char)) { if (started) { args.push(token); token = ''; started = false } continue }
    token += char; started = true
  }
  if (escaped || quote) throw new Error('命令中的引号或转义未结束。')
  if (started) args.push(token)
  if (!args.length || args.length > 256 || !args[0]) throw new Error('请输入一条 Redis 命令。')
  return args
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

import { parseRedisCommand } from '../shared/redis-command.ts'

type Rule = string | [string, string]
const configuredRules = (): Rule[] => {
  try {
    const value: unknown = JSON.parse(process.env.DSH_REDIS_COMMAND_BLACKLIST || '[]')
    if (!Array.isArray(value) || value.some(rule => typeof rule === 'string' ? !rule.trim() : !Array.isArray(rule) || rule.length !== 2 || rule.some(part => typeof part !== 'string' || !part.trim()))) throw new Error()
    return value as Rule[]
  } catch { throw new Error('Host Redis 命令黑名单配置无效。') }
}

/** Only Host configuration controls the blacklist. Empty by default. */
export function authorizeRedisCommand(command: string, rules: Rule[] = configuredRules()): string[] {
  const args = parseRedisCommand(command)
  const name = args[0].toUpperCase(), sub = args[1]?.toUpperCase()
  if (rules.some(rule => typeof rule === 'string' ? rule.toUpperCase() === name : rule[0].toUpperCase() === name && rule[1].toUpperCase() === sub)) throw new Error('此 Redis 命令被 Host 配置禁止。')
  return args
}

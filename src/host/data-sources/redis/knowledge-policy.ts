import { createHash } from 'node:crypto'
import { parseRedisCommand, redisCommandContainsCredential } from '../../../shared/redis-command.ts'

export function checkedRedisKnowledge(text: string): string[] {
  const args = parseRedisCommand(text)
  if (redisCommandContainsCredential(args)) throw new Error('这条命令可能包含凭据，不能保存到知识库。')
  return args
}

export function redisKnowledgeFingerprint(args: string[]): string {
  const normalized = [args[0].toUpperCase(), ...args.slice(1)].join('\0')
  return createHash('sha256').update(normalized).digest('hex')
}

export const redisKnowledgePolicy = {
  id: 'redis' as const,
  analyze(text: string) {
    const args = checkedRedisKnowledge(text)
    return { fingerprint: redisKnowledgeFingerprint(args), operation: args[0].toUpperCase(), risk: '由执行时的 Redis ACL 和 Host 策略判定', semantic: false }
  },
}

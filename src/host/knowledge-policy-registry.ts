import type { DataSourceId } from '../shared/data-sources/types.ts'
import { redisKnowledgePolicy } from './data-sources/redis/knowledge-policy.ts'
import { kafkaKnowledgePolicy } from './data-sources/kafka/knowledge-policy.ts'

export type KnowledgeAnalysis = { fingerprint: string; operation: string; risk: string; semantic: boolean }
export type KnowledgePolicy = { id: DataSourceId; analyze(text: string): KnowledgeAnalysis }

export function createKnowledgePolicyRegistry<Id extends string, Policy extends { id: Id; analyze(text: string): KnowledgeAnalysis }>(policies: readonly Policy[], expectedIds: readonly Id[]) {
  const expected = new Set(expectedIds)
  const byId = new Map<Id, Policy>()
  if (expected.size !== expectedIds.length) throw new Error('知识策略声明重复。')
  for (const policy of policies) {
    if (!policy || !expected.has(policy.id) || byId.has(policy.id) || typeof policy.analyze !== 'function') throw new Error(`知识策略无效或重复：${String(policy?.id)}`)
    byId.set(policy.id, policy)
  }
  for (const id of expected) if (!byId.has(id)) throw new Error(`缺少知识策略：${id}`)
  return Object.freeze({ get(id: Id): Policy {
    const policy = byId.get(id)
    if (!policy) throw new Error(`不支持此知识数据源：${String(id)}`)
    return policy
  } })
}

export const knowledgePolicies = createKnowledgePolicyRegistry([redisKnowledgePolicy, kafkaKnowledgePolicy], ['redis' as DataSourceId, 'kafka' as DataSourceId])

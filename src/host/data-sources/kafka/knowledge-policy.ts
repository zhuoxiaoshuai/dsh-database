import { createHash } from 'node:crypto'
import { formatKafkaCommand, parseKafkaCommand } from './command.mjs'
import type { KnowledgePolicy } from '../../knowledge-policy-registry.ts'

export const kafkaKnowledgePolicy: KnowledgePolicy = {
  id: 'kafka',
  analyze(text) {
    const command = parseKafkaCommand(text)
    if (['produce', 'produce-batch', 'tombstone', 'create-topic', 'set-group-offsets'].includes(command.kind))
      throw new Error('Kafka 写操作草稿不能保存为经验；请在工作台或 AI 共编文档中显式执行。')
    const normalized = formatKafkaCommand(command)
    return { fingerprint: `kafka:${createHash('sha256').update(normalized).digest('hex')}`,
      operation: command.kind.toUpperCase(), risk: 'readonly', semantic: false }
  },
}

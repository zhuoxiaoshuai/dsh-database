import { createHash } from 'node:crypto'
import { formatKafkaCommand, parseKafkaCommand } from './command.mjs'
import type { KnowledgePolicy } from '../../knowledge-policy-registry.ts'

export const kafkaKnowledgePolicy: KnowledgePolicy = {
  id: 'kafka',
  analyze(text) {
    const command = parseKafkaCommand(text)
    const normalized = formatKafkaCommand(command)
    return { fingerprint: `kafka:${createHash('sha256').update(normalized).digest('hex')}`,
      operation: command.kind.toUpperCase(), risk: 'readonly', semantic: false }
  },
}

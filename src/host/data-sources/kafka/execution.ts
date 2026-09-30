import { parseKafkaCommand } from './command.mjs'
import type { PreparedTextOperation } from '../module-types.ts'

export const kafkaExecution = {
  normalizeContext(raw: unknown) {
    if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'database' || (raw as Record<string, unknown>)[key] !== ''))) throw new Error('Kafka 当前不支持附加执行目标。')
    return {}
  },
  authorize(prepared: PreparedTextOperation, actor: 'user' | 'ai') {
    if (actor !== 'user' && actor !== 'ai') throw new Error('执行身份无效。')
    const verified = kafkaExecution.prepareText(prepared.text)
    if (verified.action !== prepared.action || verified.operation !== prepared.operation) throw new Error('Kafka 仅允许已解析的读取操作。')
  },
  prepareText(text: unknown) {
    const operation = parseKafkaCommand(text) as { kind: 'topics' | 'describe' | 'peek' | 'groups' | 'group' | 'group-topic'; topic?: string; partition?: number; groupId?: string }
    const action = operation.kind === 'topics' ? 'kafka-topics'
      : operation.kind === 'describe' ? 'kafka-describe'
      : operation.kind === 'peek' ? 'kafka-peek'
      : operation.kind === 'groups' ? 'kafka-groups'
      : operation.kind === 'group' || operation.kind === 'group-topic' ? 'kafka-group'
      : ''
    if (!action) throw new Error('未知 Kafka 操作')
    const title = operation.kind === 'topics' ? '列出 Topic'
      : operation.kind === 'describe' ? `查看 Topic ${operation.topic}`
      : operation.kind === 'peek' ? `读取 ${operation.topic} 分区 ${operation.partition}`
      : operation.kind === 'groups' ? '列出消费组'
      : operation.kind === 'group-topic' ? `查看消费组 ${operation.groupId} / ${operation.topic}`
      : `查看消费组 ${operation.groupId}`
    return { action, text: String(text), input: { text: String(text) }, operation: `kafka_${operation.kind}`, title,
      classifyResult: (result: Record<string, unknown>) => result.kind === 'peek' && (result.reason === 'deadline' || result.reason === 'error') ? 'failed' as const
        : result.kind === 'peek' && result.reason === 'cancelled' ? 'cancelled' as const : 'succeeded' as const,
      summarize: (result: Record<string, unknown>) => operation.kind === 'peek'
        ? `读取 ${Array.isArray(result.messages) ? result.messages.length : 0} 条消息${result.reason === 'limit' ? '，达到条数上限' : result.reason === 'bytes' ? '，达到结果大小上限' : result.reason === 'deadline' ? '，截止时间前未完成' : result.reason === 'error' ? '，连接中断' : result.reason === 'cancelled' ? '，已取消' : ''}。`
        : operation.kind === 'groups' ? `列出 ${Array.isArray(result.groups) ? result.groups.length : 0} 个消费组。` : '读取完成。' }
  },
}

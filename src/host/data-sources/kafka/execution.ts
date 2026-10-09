import { parseKafkaCommand } from './command.mjs'
import type { PreparedTextOperation } from '../module-types.ts'
import type { Connection } from '../../../shared/workbench.ts'
import { limitKafkaResult } from './result.mjs'

const writeKinds = new Set(['produce', 'produce-batch', 'tombstone', 'create-topic', 'set-group-offsets'])

export const kafkaExecution = {
  normalizeContext(raw: unknown) {
    if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'database' || (raw as Record<string, unknown>)[key] !== ''))) throw new Error('Kafka 当前不支持附加执行目标。')
    return {}
  },
  authorize(prepared: PreparedTextOperation, actor: 'user' | 'ai', binding: Connection) {
    prepared.queue = actor === 'ai' ? 'ai' : 'manual'
    if (actor !== 'user' && actor !== 'ai') throw new Error('执行身份无效。')
    const verified = kafkaExecution.prepareText(prepared.text)
    if (verified.action !== prepared.action || verified.operation !== prepared.operation) throw new Error('Kafka 操作与已解析命令不匹配。')
    if (writeKinds.has(verified.operation.slice('kafka_'.length)) && binding.environment !== 'sit') throw new Error('Kafka 写操作仅在 SIT 开放。')
  },
  prepareText(text: unknown) {
    const operation = parseKafkaCommand(text) as { kind: 'topics' | 'describe' | 'peek' | 'groups' | 'group' | 'group-topics' | 'group-topic' | 'produce' | 'topic-config' | 'time-offsets' | 'scan' | 'produce-batch' | 'tombstone' | 'create-topic' | 'set-group-offsets'; topic?: string; partition?: number; groupId?: string; replayFrom?: { topic: string; partition: number; offset: string } }
    const action = operation.kind === 'topics' ? 'kafka-topics'
      : operation.kind === 'describe' ? 'kafka-describe'
      : operation.kind === 'peek' ? 'kafka-peek'
      : operation.kind === 'produce' ? 'kafka-produce'
      : operation.kind === 'topic-config' ? 'kafka-topic-config'
      : operation.kind === 'time-offsets' ? 'kafka-time-offsets'
      : operation.kind === 'scan' ? 'kafka-scan'
      : operation.kind === 'produce-batch' ? 'kafka-produce-batch'
      : operation.kind === 'tombstone' ? 'kafka-tombstone'
      : operation.kind === 'create-topic' ? 'kafka-create-topic'
      : operation.kind === 'set-group-offsets' ? 'kafka-set-group-offsets'
      : operation.kind === 'groups' ? 'kafka-groups'
      : operation.kind === 'group' || operation.kind === 'group-topic' || operation.kind === 'group-topics' ? 'kafka-group'
      : ''
    if (!action) throw new Error('未知 Kafka 操作')
    const title = operation.kind === 'topics' ? '列出 Topic'
      : operation.kind === 'describe' ? `查看 Topic ${operation.topic}`
      : operation.kind === 'peek' ? `读取 ${operation.topic} 分区 ${operation.partition}`
      : operation.kind === 'produce' ? `向 ${operation.topic} 发布单条消息`
      : operation.kind === 'produce-batch' ? `向 ${operation.topic} 批量发布消息`
      : operation.kind === 'tombstone' ? `向 ${operation.topic} 发布墓碑`
      : operation.kind === 'create-topic' ? `创建测试 Topic ${operation.topic}`
      : operation.kind === 'set-group-offsets' ? `调整消费组 ${operation.groupId} 位点`
      : operation.kind === 'topic-config' ? `查看 ${operation.topic} 配置`
      : operation.kind === 'time-offsets' ? `按时间定位 ${operation.topic}`
      : operation.kind === 'scan' ? `扫描 ${operation.topic}`
      : operation.kind === 'groups' ? '列出消费组'
      : operation.kind === 'group-topics' ? `列出消费组 ${operation.groupId} 的 Topic`
      : operation.kind === 'group-topic' ? `查看消费组 ${operation.groupId} / ${operation.topic}`
      : `查看消费组 ${operation.groupId}`
    return { sourceKind: 'kafka' as const, action, text: String(text), input: { text: String(text) }, operation: `kafka_${operation.kind}`, title,
      recordPolicy: 'owned' as const,
      projectLiveResult: (result: Record<string, unknown>) => limitKafkaResult(result),
      ...(writeKinds.has(operation.kind) ? {
        classifyInterruption: (error: unknown, lifecycle: { aborted: boolean; dispatched: boolean }) =>
          (error as { effect?: string } | undefined)?.effect === 'none' ? (lifecycle.aborted ? 'cancelled' as const : 'failed' as const)
            : lifecycle.dispatched || (error as { effect?: string } | undefined)?.effect === 'unknown' ? 'unknown' as const : 'failed' as const,
        completedResultIsDefinitive: true,
      } : {}),
      classifyResult: (result: Record<string, unknown>) => result.kind === 'produce-batch' && typeof result.status === 'string' ? result.status as 'succeeded' | 'failed' | 'cancelled' | 'unknown'
        : result.kind === 'peek' && (result.reason === 'deadline' || result.reason === 'error') ? 'failed' as const
        : result.kind === 'peek' && result.reason === 'cancelled' ? 'cancelled' as const : 'succeeded' as const,
      summarize: (result: Record<string, unknown>) => operation.kind === 'produce'
        ? `已收到 Broker 确认：${operation.topic}，分区 ${result.partition ?? '?'}${result.baseOffset !== undefined ? `，Offset ${result.baseOffset}` : ''}${operation.replayFrom ? `；来源 ${operation.replayFrom.topic}/${operation.replayFrom.partition}/${operation.replayFrom.offset}` : ''}。`
        : operation.kind === 'produce-batch' ? `批量发布已确认 ${Array.isArray(result.receipts) ? result.receipts.length : 0} 条${result.status === 'succeeded' ? '。' : '，其余条目请核验。'}`
        : operation.kind === 'tombstone' ? `墓碑发布已获 Broker 确认：${operation.topic}，分区 ${result.partition ?? '?'}。`
        : operation.kind === 'create-topic' ? `Topic ${operation.topic} 创建已确认。`
        : operation.kind === 'set-group-offsets' ? `消费组 ${operation.groupId} 位点已调整并回读。`
        : operation.kind === 'scan' ? `扫描 ${result.inspected ?? 0} 条，匹配 ${Array.isArray(result.messages) ? result.messages.length : 0} 条${result.complete ? '。' : '，范围未查完。'}`
        : operation.kind === 'peek'
        ? `读取 ${Array.isArray(result.messages) ? result.messages.length : 0} 条消息${result.reason === 'limit' ? '，达到条数上限' : result.reason === 'bytes' ? '，达到结果大小上限' : result.reason === 'deadline' ? '，截止时间前未完成' : result.reason === 'error' ? '，连接中断' : result.reason === 'cancelled' ? '，已取消' : ''}。`
        : operation.kind === 'groups' ? `列出 ${Array.isArray(result.groups) ? result.groups.length : 0} 个消费组${result.truncated ? '，尚有后续结果' : ''}。`
        : operation.kind === 'topics' || operation.kind === 'group-topics' ? `列出 ${Array.isArray(result.topics) ? result.topics.length : 0} 个 Topic${result.truncated ? '，尚有后续结果' : ''}。`
        : result.resultTruncated ? '读取完成，详情已按大小限制截断。' : '读取完成。' }
  },
}

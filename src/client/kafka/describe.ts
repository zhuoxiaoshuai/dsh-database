export type { KafkaPartition as KafkaPartitionRow } from '../../shared/kafka-inspection.ts'
import type { KafkaPartition as KafkaPartitionRow } from '../../shared/kafka-inspection.ts'

export function kafkaPeekCommand(topic: string, partition: number): string {
  return `PEEK ${JSON.stringify(topic)} PARTITION ${partition} FROM LATEST LIMIT 20`
}

export function kafkaInternalTopic(name: string): boolean {
  return name.startsWith('__')
}

export function kafkaLeaderText(leader: number | null | undefined): string {
  return leader == null || leader < 0 ? '无' : String(leader)
}

// End 与 Earliest 相等即视为空分区（无未消费的新消息）
export function kafkaIsEmptyWatermark(low?: string, high?: string): boolean {
  return low !== undefined && high !== undefined && low !== '' && high !== '' && low === high
}

// Topic 级指标：消息总量（End 合计）、空分区数、ISR 落后于副本数的分区数
export function kafkaMessageTotals(partitions: readonly KafkaPartitionRow[]): { total: string; empty: number; isrBehind: number } {
  let total = 0n
  let counted = false
  let empty = 0
  let isrBehind = 0
  for (const row of partitions) {
    if (kafkaIsEmptyWatermark(row.low, row.high)) empty += 1
    if (Array.isArray(row.replicas) && row.replicas.length > 0 && Array.isArray(row.isr) && row.isr.length < row.replicas.length) isrBehind += 1
    if (row.high != null && row.high !== '') {
      try {
        total += BigInt(row.high)
        counted = true
      } catch {
        // 非数字水位不参与累计
      }
    }
  }
  return { total: counted ? total.toString() : '-', empty, isrBehind }
}

export function kafkaReplicasText(replicas?: number[]): string {
  return replicas?.length ? replicas.join(', ') : '无'
}

export function kafkaReplicaFactor(partitions: readonly KafkaPartitionRow[]): number | undefined {
  if (!partitions.length) return undefined
  let factor: number | undefined
  for (const row of partitions) {
    const n = Array.isArray(row.replicas) ? row.replicas.length : 0
    if (n === 0) return undefined
    if (factor === undefined) factor = n
    else if (factor !== n) return undefined
  }
  return factor
}

export function kafkaTopicSummary(topic: string, partitions: readonly KafkaPartitionRow[], peek = true): string {
  const parts = kafkaInternalTopic(topic) ? ['内部 Topic'] : []
  parts.push(`${partitions.length} 个分区`)
  const factor = kafkaReplicaFactor(partitions)
  if (factor !== undefined) parts.push(`副本因子 ${factor}`)
  if (peek && partitions.length) parts.push('点击分区创建有界读取草稿。')
  return parts.join(' · ')
}

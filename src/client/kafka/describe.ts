export type KafkaPartitionRow = {
  partition: number
  leader?: number | null
  replicas?: number[]
  low?: string
  high?: string
}

export function kafkaPeekCommand(topic: string, partition: number): string {
  return `PEEK ${JSON.stringify(topic)} PARTITION ${partition} FROM LATEST LIMIT 20`
}

export function kafkaInternalTopic(name: string): boolean {
  return name.startsWith('__')
}

export function kafkaLeaderText(leader: number | null | undefined): string {
  return leader == null || leader < 0 ? '无' : String(leader)
}

export function kafkaHighWatermarkText(low?: string, high?: string): string {
  const hi = high ?? ''
  if (low !== undefined && high !== undefined && low !== '' && high !== '' && low === high) return `${hi} · 空`
  return hi
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

import type { KafkaGroupSummary } from '../../shared/kafka-inspection.ts'

export function kafkaGroupSummary(group: { state?: string; protocolType?: string; protocol?: string; members?: readonly unknown[] }): string {
  const parts = [group.state || '未知状态']
  if (group.protocolType) parts.push(group.protocolType)
  if (group.protocol) parts.push(group.protocol)
  parts.push(`${group.members?.length ?? 0} 个成员`)
  return parts.join(' · ')
}

// 状态徽章色调映射：Stable→ok、Empty→warn、Dead→error，其余归为中性
const KAFKA_STATE_TONES: Record<string, string> = { stable: 'ok', empty: 'warn', dead: 'error' }

export function kafkaStateTone(state: unknown): string {
  return KAFKA_STATE_TONES[String(state ?? '').toLowerCase()] ?? 'idle'
}

// 仅当已知 Lag 大于 0 时判定为有积压（complete 取 totalLag，否则取 knownLag）
export function kafkaLagOverZero(summary: Pick<KafkaGroupSummary, 'totalLag' | 'knownLag' | 'complete'> | undefined): boolean {
  if (!summary) return false
  const lag = summary.complete && summary.totalLag != null ? summary.totalLag : summary.knownLag
  try {
    return BigInt(lag ?? 0) > 0n
  } catch {
    return false
  }
}

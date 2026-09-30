export function kafkaGroupSummary(group: { state?: string; protocolType?: string; protocol?: string; members?: readonly unknown[] }): string {
  const parts = [group.state || '未知状态']
  if (group.protocolType) parts.push(group.protocolType)
  if (group.protocol) parts.push(group.protocol)
  parts.push(`${group.members?.length ?? 0} 个成员`)
  return parts.join(' · ')
}

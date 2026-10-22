export type KafkaPartition = {
  partition: number; leader?: number | null; replicas?: number[]; isr?: number[]; offlineReplicas?: number[]
  low?: string; high?: string; errorCode?: number; health?: string
}
export type KafkaGroupMember = {
  memberId: string; clientId: string; clientHost: string; assignment: Record<string, number[]>
  assignmentKnown?: boolean
}
export type KafkaGroupResult = {
  kind: 'group'; groupId: string; state: string; protocol: string; protocolType: string; members: KafkaGroupMember[]
  complete?: boolean; collectedAt?: string; warning?: string; resultTruncated?: boolean
}
export type KafkaConsumptionPartition = {
  partition: number; current: string | null; end: string | null; lag: string | null; consumer: string | null
  earliest?: string | null; status?: 'normal' | 'uncommitted' | 'before-earliest' | 'beyond-end' | 'unreadable'
  consumerId?: string | null; clientId?: string | null; host?: string | null
}
export type KafkaGroupTopicResult = {
  kind: 'group-topic'; groupId: string; topic: string; state?: string; partitions: KafkaConsumptionPartition[]
  complete?: boolean; collectedAt?: string; warning?: string; resultTruncated?: boolean
}
export type KafkaLagSummary = {
  totalLag: string | null; knownLag: string; knownPartitions: number; partitionCount: number
  complete: boolean; abnormalPartitions: number; uncommittedPartitions: number
}
export type KafkaTopicAssociation = { groupId: string; assigned: boolean; committed: boolean; complete: boolean }
export type KafkaTopicGroupsResult = {
  kind: 'topic-groups'; topic: string; associations: KafkaTopicAssociation[]; nextCursor?: string
  complete: boolean; failed: number; scanned: number; collectedAt: string; warning?: string; resultTruncated?: boolean
}
export type KafkaTopicConsumption = KafkaLagSummary & { topic: string; assignedPartitions: number }
export type KafkaGroupSummary = KafkaLagSummary & {
  kind: 'group-summary'; groupId: string; topics: KafkaTopicConsumption[]; topicCount: number; collectedAt: string; warning?: string; resultTruncated?: boolean
}

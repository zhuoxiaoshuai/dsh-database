import React from 'react'
import { DbTable } from '../workspace/parts/layout/db-table.tsx'
import { compareDbIntegers } from '../workspace/parts/layout/db-table.ts'
import {
  kafkaIsEmptyWatermark, kafkaLeaderText, kafkaMessageTotals, kafkaPeekCommand, kafkaReplicasText, kafkaTopicSummary,
  type KafkaPartitionRow,
} from './describe.ts'

/** Same DESCRIBE partition table for 查询结果 and Topic 总览. */
export function KafkaDescribeTable({ topic, partitions, onUse, heading = true, collectedAt }: {
  topic: string
  partitions: readonly KafkaPartitionRow[]
  onUse?(text: string): void
  heading?: boolean
  collectedAt?: string
}): React.ReactElement {
  const stats = kafkaMessageTotals(partitions)
  return <div className="db-kafka-results db-kafka-panel">
    {heading && <strong>{topic}</strong>}
    {heading && <p className="db-muted">{kafkaTopicSummary(topic, partitions, Boolean(onUse))}</p>}
    <div className="db-kafka-metrics">
      <div className="db-kafka-metric is-hero"><span className="db-kafka-metric-label">分区</span><span className="db-kafka-metric-value">{partitions.length}</span></div>
      <div className="db-kafka-metric"><span className="db-kafka-metric-label">消息总量（End 合计）</span><span className="db-kafka-metric-value">{stats.total}</span></div>
      <div className="db-kafka-metric"><span className="db-kafka-metric-label">空分区</span><span className="db-kafka-metric-value">{stats.empty}</span></div>
      <div className={`db-kafka-metric${stats.isrBehind > 0 ? ' is-warn' : ''}`}><span className="db-kafka-metric-label">ISR 落后</span><span className="db-kafka-metric-value">{stats.isrBehind}</span></div>
    </div>
    <div className="db-kafka-table-card">
      <div className="db-kafka-panel-head"><b>分区详情</b>{collectedAt && <span className="db-kafka-collected">采集时间：{new Date(collectedAt).toLocaleString()}</span>}<span className="db-kafka-collected">点击列头排序</span></div>
      <DbTable columns={[
        { key: 'partition', title: '分区', sortable: true, render: item => onUse
          ? <button type="button" className="db-text-button" onClick={() => onUse(kafkaPeekCommand(topic, item.partition))}>{item.partition}</button>
          : item.partition },
        { key: 'leader', title: 'Leader', sortable: true, render: item => kafkaLeaderText(item.leader) },
        { key: 'low', title: 'Earliest（低水位）', sortable: true, compare: compareDbIntegers, render: item => item.low || '-' },
        { key: 'high', title: 'End（末尾位置）', sortable: true, compare: compareDbIntegers, render: item => kafkaIsEmptyWatermark(item.low, item.high)
          ? <span className="db-kafka-empty-pill">空</span>
          : item.high || '-' },
        { key: 'replicas', title: '副本', render: item => kafkaReplicasText(item.replicas) },
        { key: 'isr', title: 'ISR', render: item => item.isr?.join(', ') ?? '-' },
        { key: 'offlineReplicas', title: '离线副本', render: item => item.offlineReplicas?.join(', ') || '-' },
      ]} rows={partitions} rowKey={item => item.partition} empty="没有分区。" />
    </div>
  </div>
}

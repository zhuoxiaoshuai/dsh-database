import React from 'react'
import { DbTable } from '../workspace/source/db-table.tsx'
import { compareDbIntegers } from '../workspace/source/db-table.ts'
import {
  kafkaHighWatermarkText, kafkaLeaderText, kafkaPeekCommand, kafkaReplicasText, kafkaTopicSummary,
  type KafkaPartitionRow,
} from './describe.ts'

/** Same DESCRIBE partition table for 查询结果 and Topic 总览. */
export function KafkaDescribeTable({ topic, partitions, onUse, heading = true }: {
  topic: string
  partitions: readonly KafkaPartitionRow[]
  onUse?(text: string): void
  heading?: boolean
}): React.ReactElement {
  return <div className="db-kafka-results">
    {heading && <strong>{topic}</strong>}
    <p className="db-muted">{kafkaTopicSummary(topic, partitions, Boolean(onUse))}</p>
    <DbTable columns={[
      { key: 'partition', title: '分区', sortable: true, render: item => onUse
        ? <button type="button" className="db-text-button" onClick={() => onUse(kafkaPeekCommand(topic, item.partition))}>{item.partition}</button>
        : item.partition },
      { key: 'leader', title: 'Leader', sortable: true, render: item => kafkaLeaderText(item.leader) },
      { key: 'low', title: '低水位', sortable: true, compare: compareDbIntegers, render: item => item.low ?? '' },
      { key: 'high', title: '高水位', sortable: true, compare: compareDbIntegers, render: item => kafkaHighWatermarkText(item.low, item.high) },
      { key: 'replicas', title: '副本', render: item => kafkaReplicasText(item.replicas) },
    ]} rows={partitions} rowKey={item => item.partition} empty="没有分区。" />
  </div>
}

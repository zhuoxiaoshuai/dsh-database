import React from 'react'
import { DbTable } from '../workspace/source/db-table.tsx'
import { compareDbIntegers } from '../workspace/source/db-table.ts'
import type { KafkaGroupResult, KafkaGroupTopicResult } from './results.tsx'
import { kafkaGroupSummary } from './group-summary.ts'

export function kafkaMetric(value: string | null | undefined): string {
  return value == null || value === '' ? '-' : value
}

export function KafkaGroupDetail({ group, heading = true }: { group: KafkaGroupResult; heading?: boolean }): React.ReactElement {
  return <div className="db-kafka-results">
    <p>{heading && <strong>{group.groupId} </strong>}<span className="db-muted">{kafkaGroupSummary(group)}</span></p>
    {group.members.length ? <ul>{group.members.map(member => <li key={member.memberId || member.clientId}>
      <strong>{member.clientId || member.memberId || '-'}</strong>
      <span className="db-muted"> {member.memberId}{member.clientHost ? ` · ${member.clientHost}` : ''}</span>
      {Object.keys(member.assignment).length > 0 && <div>{Object.entries(member.assignment).map(([topic, partitions]) => <div key={topic}>{topic} · 分区 {partitions.join(', ')}</div>)}</div>}
    </li>)}</ul> : <p className="db-muted">当前没有成员。</p>}
  </div>
}

export function KafkaGroupTopicDetail({ detail, heading = true }: { detail: KafkaGroupTopicResult; heading?: boolean }): React.ReactElement {
  return <div className="db-kafka-results">
    {heading && <p><strong>{detail.groupId}</strong> <span className="db-muted">/ {detail.topic}{detail.state ? ` · ${detail.state}` : ''}</span></p>}
    {!heading && detail.state && <p className="db-muted">{detail.state}</p>}
    <DbTable columns={[
      { key: 'partition', title: '分区', sortable: true },
      { key: 'current', title: 'Current', sortable: true, compare: compareDbIntegers, render: item => kafkaMetric(item.current) },
      { key: 'end', title: 'End', sortable: true, compare: compareDbIntegers, render: item => kafkaMetric(item.end) },
      { key: 'lag', title: 'Lag', sortable: true, compare: compareDbIntegers, render: item => kafkaMetric(item.lag) },
      { key: 'consumer', title: 'Consumer', render: item => kafkaMetric(item.consumer) },
    ]} rows={detail.partitions} rowKey={item => item.partition} empty="这个 Topic 没有可见的分区消费记录。" />
  </div>
}

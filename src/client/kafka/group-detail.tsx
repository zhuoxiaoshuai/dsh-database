import React, { useState } from 'react'
import { DbTable } from '../workspace/source/db-table.tsx'
import { compareDbIntegers } from '../workspace/source/db-table.ts'
import type { KafkaGroupResult, KafkaGroupTopicResult } from './results.tsx'
import { kafkaGroupSummary } from './group-summary.ts'

const lagSnapshots = new Map<string, Record<string, string | null>>()

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

export function KafkaGroupTopicDetail({ detail, heading = true, onUse, snapshotScope = '', canWrite = false }: { detail: KafkaGroupTopicResult; heading?: boolean; onUse?(text: string): void; snapshotScope?: string; canWrite?: boolean }): React.ReactElement {
  const [, refresh] = useState(0)
  const [targetPartition, setTargetPartition] = useState(0)
  const [targetOffset, setTargetOffset] = useState('')
  const [targetTime, setTargetTime] = useState('')
  const [targetMode, setTargetMode] = useState<'offset' | 'time'>('offset')
  const key = `${snapshotScope}\0${detail.groupId}\0${detail.topic}`
  const previous = lagSnapshots.get(key)
  return <div className="db-kafka-results">
    {heading && <p><strong>{detail.groupId}</strong> <span className="db-muted">/ {detail.topic}{detail.state ? ` · ${detail.state}` : ''}</span></p>}
    {!heading && detail.state && <p className="db-muted">{detail.state}</p>}
    <button type="button" className="db-btn" onClick={() => {
      lagSnapshots.delete(key)
      lagSnapshots.set(key, Object.fromEntries(detail.partitions.map(item => [item.partition, item.lag])))
      if (lagSnapshots.size > 100) lagSnapshots.delete(lagSnapshots.keys().next().value!)
      refresh(value => value + 1)
    }}>记录本次 Lag 快照</button>
    {previous && <p className="db-muted">相对快照：{detail.partitions.map(item => {
      const before = previous[item.partition]
      if (before == null || item.lag == null) return `分区 ${item.partition} 未知`
      const change = BigInt(item.lag) - BigInt(before)
      return `分区 ${item.partition} ${change > 0n ? '+' : ''}${change}`
    }).join('；')}</p>}
    <DbTable columns={[
      { key: 'partition', title: '分区', sortable: true, render: item => onUse && item.current != null
        ? <button type="button" className="db-text-button" onClick={() => onUse(`PEEK ${JSON.stringify(detail.topic)} PARTITION ${item.partition} FROM OFFSET ${item.current} LIMIT 20`)}>{item.partition} · 从积压起点查看</button>
        : item.partition },
      { key: 'current', title: '已提交位置', sortable: true, compare: compareDbIntegers, render: item => kafkaMetric(item.current) },
      { key: 'end', title: '末尾位置', sortable: true, compare: compareDbIntegers, render: item => kafkaMetric(item.end) },
      { key: 'lag', title: '积压量（Lag）', sortable: true, compare: compareDbIntegers, render: item => kafkaMetric(item.lag) },
      { key: 'consumer', title: '消费者', render: item => kafkaMetric(item.consumer) },
    ]} rows={detail.partitions} rowKey={item => item.partition} empty="这个 Topic 没有可见的分区消费记录。" />
    {onUse && canWrite && detail.partitions.length > 0 && <details><summary>调整消费组位点草稿（仅 SIT）</summary>
      <p className="db-muted">仅无运行成员的消费组可执行；先从上方确认当前提交位置。</p>
      <label>分区<select value={targetPartition} onChange={event => setTargetPartition(Number(event.target.value))}>{detail.partitions.map(item => <option key={item.partition} value={item.partition}>{item.partition}</option>)}</select></label>
      <label>目标类型<select value={targetMode} onChange={event => setTargetMode(event.target.value as 'offset' | 'time')}><option value="offset">指定 Offset</option><option value="time">指定时间</option></select></label>
      {targetMode === 'offset' ? <label>目标 Offset<input value={targetOffset} onChange={event => setTargetOffset(event.target.value)} /></label>
        : <label>目标时间<input type="datetime-local" value={targetTime} onChange={event => setTargetTime(event.target.value)} /></label>}
      <button type="button" className="db-btn" onClick={() => {
        const current = detail.partitions.find(item => item.partition === targetPartition)
        if (!current) return
        onUse(`SET_GROUP_OFFSETS ${JSON.stringify({ groupId: detail.groupId, topic: detail.topic,
          expected: { [targetPartition]: current.current }, ...(targetMode === 'offset' ? { offsets: { [targetPartition]: targetOffset } }
            : { timestamp: Date.parse(targetTime), partitions: [targetPartition] }) })}`)
      }}>填入位点调整草稿</button>
    </details>}
  </div>
}

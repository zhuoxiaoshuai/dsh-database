import React, { useState } from 'react'
import { DbTable } from '../workspace/parts/layout/db-table.tsx'
import { compareDbIntegers } from '../workspace/parts/layout/db-table.ts'
import type { KafkaGroupResult, KafkaGroupTopicResult } from './results.tsx'
import { kafkaGroupSummary, kafkaStateTone } from './group-summary.ts'

const lagSnapshots = new Map<string, Record<string, { lag: string | null; at: number }>>()

export function kafkaMetric(value: string | null | undefined): string {
  return value == null || value === '' ? '-' : value
}

// 汇总分区级 BigInt 指标（跳过空值/非法值），positive 用于警示色
function sumBigInt(values: readonly (string | null | undefined)[]): { text: string; positive: boolean } {
  let total = 0n
  let counted = false
  for (const value of values) {
    if (value == null || value === '') continue
    try {
      total += BigInt(value)
      counted = true
    } catch {
      // 非数字跳过
    }
  }
  return { text: counted ? total.toString() : '-', positive: counted && total > 0n }
}

export function KafkaGroupDetail({ group, heading = true }: { group: KafkaGroupResult; heading?: boolean }): React.ReactElement {
  // 空成员说明合并：状态语义 + 堆积提示只说一遍，不再单独渲染 Empty/Dead 提示行
  const emptyIntro = group.state === 'Dead'
    ? 'Dead 表示消费组无成员且元数据即将或已被 Broker 清理，重新上线后会重建消费组。'
    : '该消费组暂无活跃消费者实例——可能已停止、尚未启动，或正在重启中。'
  const emptyExtra = group.state === 'Dead'
    ? ''
    : '组内无成员不等于消息堆积为 0，堆积情况以 Total Lag 为准；历史位点仍保留在 Kafka 服务端，重新上线后可继续消费。'
  const countText = group.resultTruncated ? `已显示 ${group.members.length} 个成员（部分）` : `${group.members.length} 个成员`
  const stateBadge = <span className={`db-kafka-state is-${kafkaStateTone(group.state)}`}>{group.state || '未知状态'}</span>
  const collected = group.collectedAt && <span className="db-kafka-collected">采集时间：{new Date(group.collectedAt).toLocaleString()}</span>
  // 页签内（heading=false）状态徽章并入卡头，命令结果视图（heading=true）保留独立状态行
  const headMeta = heading ? null : <>{stateBadge}<span className="db-muted">{countText}</span></>
  return <div className="db-kafka-results db-kafka-group-detail">
    {group.warning && <p className="db-info-note">{group.warning}</p>}
    {group.complete === false && <p className="db-info-note">成员或分区分配信息不完整。</p>}
    {heading && <p><strong>{group.groupId} </strong>{stateBadge}<span className="db-muted"> · {countText}</span></p>}
    {group.members.length === 0
      ? <div className="db-kafka-empty-card">
          <div className="db-kafka-empty-head"><b>成员</b>{headMeta}{collected}</div>
          <div className="db-kafka-empty-body">
            <div className="db-kafka-empty-ic" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="17" cy="9" r="2.4"/><path d="M15.8 14.3c2.3.3 4 1.9 4.6 4.7"/></svg></div>
            <b>当前没有成员</b>
            <span>{emptyIntro}{emptyExtra}</span>
          </div>
        </div>
      : <div className="db-kafka-table-card">
          <div className="db-kafka-panel-head"><b>成员</b>{headMeta}{collected}</div>
          <DbTable rows={group.members} rowKey={(member,index)=>`${member.memberId || member.clientId}:${index}`} columns={[
            {key:'memberId',title:'Consumer ID',render:member=>member.memberId || '-'},
            {key:'clientId',title:'客户端',render:member=>member.clientId || '-'},
            {key:'clientHost',title:'Host',render:member=>member.clientHost || '-'},
            {key:'assignment',title:'分区分配',render:member=>member.assignmentKnown === false ? '未知（解析失败）' : <div className="db-kafka-assignment">{Object.entries(member.assignment).map(([topic,partitions])=><div key={topic}>{topic} · 分区 {partitions.join(', ')}</div>)}</div>},
            {key:'partitionCount',title:'Partition Count',render:member=>member.assignmentKnown === false ? '-' : Object.values(member.assignment).reduce((sum, parts)=>sum + new Set(parts).size,0)},
          ]}/>
        </div>}
    <details className="db-resource-disclosure"><summary>技术详情</summary><div className="db-kafka-technical"><p className="db-resource-summary">{kafkaGroupSummary(group)}</p>
      {group.members.map((member,index)=><p key={member.memberId || index}><span>{member.clientId || '-'}：</span><span className="db-mono">{member.memberId || '-'}</span></p>)}
    </div></details>
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
  const lag = sumBigInt(detail.partitions.map(item => item.lag))
  const committed = sumBigInt(detail.partitions.map(item => item.current))
  return <div className="db-kafka-results db-kafka-panel">
    {heading && <p><strong>{detail.groupId}</strong> <span className="db-muted">/ {detail.topic}</span>{detail.state && <span className={`db-kafka-state is-${kafkaStateTone(detail.state)}`}>{detail.state}</span>}{detail.state === 'Empty' && <span className="db-muted">组内该 Topic 无活跃消费者分配</span>}</p>}
    {!heading && detail.state && <p className="db-kafka-system-row"><span className={`db-kafka-state is-${kafkaStateTone(detail.state)}`}>{detail.state}</span>{detail.state === 'Empty' && <span className="db-muted">组内该 Topic 无活跃消费者分配</span>}</p>}
    <div className="db-kafka-metrics">
      <div className={`db-kafka-metric is-hero${lag.positive ? ' is-warn' : ''}`}><span className="db-kafka-metric-label">总积压（Lag）</span><span className="db-kafka-metric-value">{lag.text}</span></div>
      <div className="db-kafka-metric"><span className="db-kafka-metric-label">分区</span><span className="db-kafka-metric-value">{detail.partitions.length}</span></div>
      <div className="db-kafka-metric"><span className="db-kafka-metric-label">已提交位点</span><span className="db-kafka-metric-value">{committed.text} <small>累计</small></span></div>
    </div>
    <div className="db-kafka-table-card">
      <div className="db-kafka-panel-head">
        <b>分区消费</b>
        {detail.collectedAt && <span className="db-kafka-collected">采集时间：{new Date(detail.collectedAt).toLocaleString()}</span>}
        <button type="button" className="db-text-button" onClick={() => {
          lagSnapshots.delete(key)
          lagSnapshots.set(key, Object.fromEntries(detail.partitions.map(item => [item.partition, { lag: item.lag, at: Date.now() }])))
          if (lagSnapshots.size > 100) lagSnapshots.delete(lagSnapshots.keys().next().value!)
          refresh(value => value + 1)
        }}>记录本次 Lag 快照</button>
      </div>
      {previous && <p className="db-kafka-snapshot-note">相对快照：{detail.partitions.map(item => {
        const before = previous[item.partition]
        if (before == null || item.lag == null || before.lag == null) return `分区 ${item.partition} 未知`
        const change = BigInt(item.lag) - BigInt(before.lag)
        return `分区 ${item.partition} ${change > 0n ? '+' : ''}${change}`
      }).join('；')}</p>}
      <DbTable columns={[
        { key: 'partition', title: '分区', sortable: true, render: item => onUse && item.current != null && (!item.status || item.status === 'normal')
          ? <button type="button" className="db-text-button" title="从积压起点查看" onClick={() => onUse(`PEEK ${JSON.stringify(detail.topic)} PARTITION ${item.partition} FROM OFFSET ${item.current} LIMIT 20`)}>{item.partition}</button>
          : item.partition },
        { key: 'current', title: '已提交位置', sortable: true, compare: compareDbIntegers, render: item => kafkaMetric(item.current) },
        { key: 'earliest', title: 'Earliest', render: item => kafkaMetric(item.earliest) },
        { key: 'end', title: '末尾位置', sortable: true, compare: compareDbIntegers, render: item => kafkaMetric(item.end) },
        { key: 'lag', title: '积压量（Lag）', sortable: true, compare: compareDbIntegers, render: item => item.lag == null || item.lag === ''
          ? '-'
          : item.lag === '0'
            ? <span className="db-kafka-lag-zero">0</span>
            : <span className="db-kafka-lag-chip">{item.lag}</span> },
        { key: 'host', title: 'Host', render: item => kafkaMetric(item.host) },
        { key: 'snapshot', title: '位点快照', render: item => {
          const before = previous?.[item.partition]
          if (!before) return <span className="db-kafka-lag-zero">无</span>
          if (before.lag == null) return <span className="db-kafka-lag-zero">未知</span>
          return <span className="db-kafka-lag-ok">{before.lag} · {new Date(before.at).toLocaleDateString()}</span>
        } },
      ]} rows={detail.partitions} rowKey={item => item.partition} empty="这个 Topic 没有可见的分区消费记录。" />
      <div className="db-kafka-foot">Offset 差值不是精确消息条数；Lag 为 0 不代表下游业务处理完成。在线成员也不代表正在处理消息。</div>
    </div>
    {onUse && canWrite && detail.partitions.length > 0 && <details className="db-resource-disclosure db-kafka-danger"><summary>调整消费组位点草稿 <span className="db-kafka-sit-tag">仅 SIT</span></summary><div className="db-resource-form db-kafka-form">
      <p className="db-muted">危险操作：位点位移会跳过或重复消费；仅无运行成员的消费组可执行，先从上方确认当前提交位置。</p>
      <label>分区<select value={targetPartition} onChange={event => setTargetPartition(Number(event.target.value))}>{detail.partitions.map(item => <option key={item.partition} value={item.partition}>{item.partition}</option>)}</select></label>
      <label>目标类型<select value={targetMode} onChange={event => setTargetMode(event.target.value as 'offset' | 'time')}><option value="offset">指定 Offset</option><option value="time">指定时间</option></select></label>
      {targetMode === 'offset' ? <label>目标 Offset<input value={targetOffset} onChange={event => setTargetOffset(event.target.value)} /></label>
        : <label>目标时间<input type="datetime-local" value={targetTime} onChange={event => setTargetTime(event.target.value)} /></label>}
      <button type="button" className="db-primary" onClick={() => {
        const current = detail.partitions.find(item => item.partition === targetPartition)
        if (!current) return
        onUse(`SET_GROUP_OFFSETS ${JSON.stringify({ groupId: detail.groupId, topic: detail.topic,
          expected: { [targetPartition]: current.current }, ...(targetMode === 'offset' ? { offsets: { [targetPartition]: targetOffset } }
            : { timestamp: Date.parse(targetTime), partitions: [targetPartition] }) })}`)
      }}>填入位点调整草稿</button>
    </div></details>}
  </div>
}

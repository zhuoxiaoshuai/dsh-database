import React from 'react'
import { KafkaGroupDetail, KafkaGroupTopicDetail } from './group-detail.tsx'
import { KafkaDescribeTable } from './describe-table.tsx'

type Bytes = { kind: 'null' | 'text' | 'binary'; length: number; truncated?: boolean; text?: string; base64?: string }
type KafkaMessage = { offset: string; timestamp: string; key: Bytes; value: Bytes; headers: Record<string, Bytes | Bytes[]> }
export type KafkaGroupMember = { memberId: string; clientId: string; clientHost: string; assignment: Record<string, number[]> }
export type KafkaGroupResult = { kind: 'group'; groupId: string; state: string; protocol: string; protocolType: string; members: KafkaGroupMember[] }
export type KafkaGroupTopicResult = {
  kind: 'group-topic'
  groupId: string
  topic: string
  state?: string
  partitions: { partition: number; current: string | null; end: string | null; lag: string | null; consumer: string | null }[]
}
export type KafkaResult = {
  kind: 'topics' | 'describe' | 'peek' | 'groups' | 'group' | 'group-topic'
  topics?: string[]
  groups?: string[]
  truncated?: boolean
  nextCursor?: string
  topic?: string
  partitions?: { partition: number; leader: number; replicas: number[]; low: string; high: string }[]
  partition?: number
  low?: string
  high?: string
  start?: string
  messages?: KafkaMessage[]
  complete?: boolean
  reason?: string
  elapsedMs?: number
  executionId?: string
  groupId?: string
  state?: string
  protocol?: string
  protocolType?: string
  members?: KafkaGroupMember[]
}

function KafkaBytes({ value }: { value?: Bytes }) {
  if (!value || value.kind === 'null') return <span className="db-muted">null</span>
  if (value.length === 0) return <span className="db-muted">空字节 · 0 B</span>
  return <span>{value.kind === 'text' ? <code>{value.text}</code> : <code>Base64: {value.base64}</code>}<small className="db-muted"> · {value.length} B{value.truncated ? ' · 预览已截断' : ''}</small></span>
}

export function KafkaResultView({ result, onUse }: { result?: KafkaResult; onUse?(text: string): void }): React.ReactElement {
  if (!result) return <p className="db-muted db-query-result-empty">执行后在此显示 Kafka 结果。</p>
  if (result.kind === 'topics') return <div className="db-kafka-results"><p className="db-muted">本页 {result.topics?.length || 0} 个 Topic{result.truncated ? ' · 还有后续页' : ''}</p>
    <ul>{(result.topics || []).map(topic => <li key={topic}><button type="button" className="db-text-button" onClick={() => onUse?.(`DESCRIBE ${JSON.stringify(topic)}`)}>{topic}</button></li>)}</ul></div>
  if (result.kind === 'describe') return <KafkaDescribeTable topic={result.topic || ''} partitions={result.partitions || []} onUse={onUse} />
  if (result.kind === 'groups') return <div className="db-kafka-results"><p className="db-muted">本页 {result.groups?.length || 0} 个消费组{result.truncated ? ' · 还有后续页' : ''}</p>
    <ul>{(result.groups || []).map(groupId => <li key={groupId}><button type="button" className="db-text-button" onClick={() => onUse?.(`GROUP ${JSON.stringify(groupId)}`)}>{groupId}</button></li>)}</ul></div>
  if (result.kind === 'group' && result.groupId && result.members) return <KafkaGroupDetail group={{ kind: 'group', groupId: result.groupId, state: result.state || '', protocol: result.protocol || '', protocolType: result.protocolType || '', members: result.members }} />
  if (result.kind === 'group-topic' && result.groupId && result.topic) {
    const topic = result as unknown as KafkaGroupTopicResult
    return <KafkaGroupTopicDetail detail={{ kind: 'group-topic', groupId: topic.groupId, topic: topic.topic, state: topic.state, partitions: topic.partitions || [] }} />
  }
  if (result.kind !== 'peek') return <p className="db-muted">无法显示该 Kafka 结果。</p>
  return <div className="db-kafka-results"><p className="db-muted">{result.topic} · 分区 {result.partition} · 本次范围 [{result.start}, {result.high}) · {result.messages?.length || 0} 条 · {result.elapsedMs || 0} ms</p>
    {result.complete ? <p>已到达本次读取上界。</p> : <p className="db-info-note">读取未遍历完整范围（{result.reason === 'limit' ? '达到条数上限' : result.reason === 'bytes' ? '达到结果大小上限' : result.reason === 'deadline' ? '超过读取截止时间' : result.reason === 'cancelled' ? '已请求取消' : result.reason === 'error' ? '读取连接中断' : '读取中断'}）。LATEST 可能因压缩或 offset 空洞少于指定条数。</p>}
    {(result.messages || []).map(message => <article className="db-kafka-message" key={message.offset}>
      <header><strong>Offset {message.offset}</strong><span>{message.timestamp}</span></header>
      <p><b>Key：</b><KafkaBytes value={message.key} /></p><p><b>Value：</b><KafkaBytes value={message.value} /></p>
      {Object.keys(message.headers || {}).length > 0 && <details><summary>Headers</summary>{Object.entries(message.headers).map(([name, value]) => <p key={name}><b>{name}：</b>{(Array.isArray(value) ? value : [value]).map((part, index) => <React.Fragment key={index}>{index > 0 && '；'}<KafkaBytes value={part} /></React.Fragment>)}</p>)}</details>}
    </article>)}
  </div>
}

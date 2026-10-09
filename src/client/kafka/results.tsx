import React, { useState } from 'react'
import { KafkaGroupDetail, KafkaGroupTopicDetail } from './group-detail.tsx'
import { KafkaDescribeTable } from './describe-table.tsx'
import { kafkaJsonPreview, kafkaExportText, type KafkaBytesValue } from './message-view.ts'

type Bytes = KafkaBytesValue
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
  kind: 'topics' | 'describe' | 'peek' | 'groups' | 'group' | 'group-topics' | 'group-topic' | 'produce'
    | 'topic-config' | 'time-offsets' | 'scan' | 'produce-batch' | 'tombstone' | 'create-topic' | 'set-group-offsets'
  topics?: string[]
  groups?: string[]
  truncated?: boolean
  resultTruncated?: boolean
  search?: string
  warning?: string
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
  acknowledged?: boolean
  baseOffset?: string
  valueBytes?: number
  configs?: Record<string, { value: string | null; isDefault: boolean }>
  timestamp?: number
  inspected?: number
  nextOffsets?: Record<string, string>
  key?: string | { base64: string }
  header?: { name: string; value: string | { base64: string } }
  ranges?: { partition: number; low: string; high: string; complete: boolean; reason: string }[]
  receipts?: { index: number; partition: number; baseOffset?: string; valueBytes: number; acknowledged: boolean }[]
  failedIndex?: number
  notSent?: number
  status?: string
  message?: string
  cleanupPolicy?: string
  replicationFactor?: number
  partitionCount?: number
  before?: Record<string, string | null>
  after?: Record<string, string>
  replayFrom?: { topic: string; partition: number; offset: string }
}

function sourceBytes(value: Bytes): string | { base64: string } | undefined {
  if (value.truncated || value.kind === 'null') return undefined
  return value.kind === 'text' ? value.text || '' : { base64: value.base64 || '' }
}

function replayCommand(topic: string, partition: number, message: KafkaMessage): string | undefined {
  const value = sourceBytes(message.value)
  if (value === undefined) return undefined
  const key = sourceBytes(message.key)
  if (message.key.kind !== 'null' && key === undefined) return undefined
  const headers: Record<string, unknown> = {}
  for (const [name, item] of Object.entries(message.headers || {})) {
    const parts = (Array.isArray(item) ? item : [item]).map(sourceBytes)
    if (parts.some(part => part === undefined)) return undefined
    headers[name] = Array.isArray(item) ? parts : parts[0]
  }
  const size = message.value.length + message.key.length + Object.values(message.headers || {}).flatMap(item => Array.isArray(item) ? item : [item]).reduce((sum, item) => sum + item.length, 0)
  if (size > 64 * 1024) return undefined
  return `PRODUCE ${JSON.stringify({ topic, ...(key !== undefined ? { key } : {}), value,
    ...(Object.keys(headers).length ? { headers } : {}), replayFrom: { topic, partition, offset: message.offset } })}`
}

function KafkaBytes({ value }: { value?: Bytes }) {
  const [showJson, setShowJson] = useState(false)
  const json = kafkaJsonPreview(value)
  if (!value || value.kind === 'null') return <span className="db-muted">null</span>
  if (value.length === 0) return <span className="db-muted">空字节 · 0 B</span>
  return <span>{json !== undefined && <button type="button" className="db-text-button" onClick={() => setShowJson(previous => !previous)}>{showJson ? '查看原文' : '查看 JSON'}</button>}{value.kind === 'text' ? <code style={{ whiteSpace: 'pre-wrap' }}>{showJson && json !== undefined ? json : value.text}</code> : <code>Base64: {value.base64}</code>}<small className="db-muted"> · {value.length} B{value.truncated ? ' · 预览已截断' : ''}</small></span>
}

function KafkaMessageView({ message, topic, partition, onUse, canWrite = false }: { message: KafkaMessage; topic: string; partition: number; onUse?(text: string): void; canWrite?: boolean }) {
  const [error, setError] = useState('')
  const replay = replayCommand(topic, partition, message)
  const [targetTopic, setTargetTopic] = useState(topic)
  const [valueEncoding, setValueEncoding] = useState<'utf8' | 'base64'>(message.value.kind === 'binary' ? 'base64' : 'utf8')
  const [keyEncoding, setKeyEncoding] = useState<'utf8' | 'base64'>(message.key.kind === 'binary' ? 'base64' : 'utf8')
  const [valueDraft, setValueDraft] = useState(message.value.kind === 'binary' ? message.value.base64 || '' : message.value.text || '')
  const [keyDraft, setKeyDraft] = useState(message.key.kind === 'binary' ? message.key.base64 || '' : message.key.text || '')
  const [headersDraft, setHeadersDraft] = useState(() => {
    const source = replay ? JSON.parse(replay.slice('PRODUCE '.length)) as { headers?: object } : {}
    return JSON.stringify(source.headers || {}, null, 2)
  })
  const copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(message, null, 2)); setError('') }
    catch { setError('复制失败，请选中预览文字复制。') }
  }
  return <article className="db-kafka-message"><header><strong>分区 {partition} · Offset {message.offset}</strong><span>{message.timestamp}</span>
    {onUse && <button type="button" className="db-text-button" onClick={() => onUse(`PEEK ${JSON.stringify(topic)} PARTITION ${partition} FROM OFFSET ${message.offset} LIMIT 20`)}>从此处查看</button>}
    <button type="button" className="db-text-button" onClick={() => void copy()}>复制消息预览</button></header>
    {error && <p role="alert" className="db-error">{error}</p>}
    <p><b>Key：</b><KafkaBytes value={message.key} /></p><p><b>Value：</b><KafkaBytes value={message.value} /></p>
    {Object.keys(message.headers || {}).length > 0 && <details><summary>Headers</summary>{Object.entries(message.headers).map(([name, value]) => <p key={name}><b>{name}：</b>{(Array.isArray(value) ? value : [value]).map((part, index) => <React.Fragment key={index}>{index > 0 && '；'}<KafkaBytes value={part} /></React.Fragment>)}</p>)}</details>}
    {onUse && canWrite && replay && <details><summary>编辑并重新发布</summary><div className="db-kafka-results">
      <p className="db-muted">来源：{topic} / 分区 {partition} / Offset {message.offset}。新消息不会覆盖原消息。</p>
      <label>目标 Topic<input value={targetTopic} onChange={event => setTargetTopic(event.target.value)} /></label>
      <label>Key 格式<select value={keyEncoding} onChange={event => setKeyEncoding(event.target.value as 'utf8' | 'base64')}><option value="utf8">UTF-8</option><option value="base64">Base64</option></select></label>
      <label>Key<input value={keyDraft} onChange={event => setKeyDraft(event.target.value)} /></label>
      <label>Value 格式<select value={valueEncoding} onChange={event => setValueEncoding(event.target.value as 'utf8' | 'base64')}><option value="utf8">UTF-8</option><option value="base64">Base64</option></select></label>
      <label>Value<textarea value={valueDraft} onChange={event => setValueDraft(event.target.value)} /></label>
      <label>Headers JSON<textarea value={headersDraft} onChange={event => setHeadersDraft(event.target.value)} /></label>
      <p className="db-muted">改动预览：目标 {targetTopic === topic ? '不变' : `${topic} → ${targetTopic}`}；Key {keyDraft === (message.key.kind === 'binary' ? message.key.base64 || '' : message.key.text || '') ? '不变' : '已修改'}；Value {valueDraft === (message.value.kind === 'binary' ? message.value.base64 || '' : message.value.text || '') ? '不变' : '已修改'}。</p>
      <button type="button" className="db-btn" onClick={() => { try {
        const headers = JSON.parse(headersDraft)
        onUse(`PRODUCE ${JSON.stringify({ topic: targetTopic,
          ...(message.key.kind !== 'null' || keyDraft ? { key: keyEncoding === 'base64' ? { base64: keyDraft } : keyDraft } : {}),
          value: valueEncoding === 'base64' ? { base64: valueDraft } : valueDraft, headers,
          replayFrom: { topic, partition, offset: message.offset } })}`)
        setError('')
      } catch { setError('Headers 必须是有效 JSON。') } }}>填入重发草稿</button>
    </div></details>}
  </article>
}

function nextListCommand(result: KafkaResult): string | undefined {
  if (!result.nextCursor || !/^(0|[1-9]\d*)$/.test(result.nextCursor)) return undefined
  const base = result.kind === 'topics' ? 'TOPICS' : result.kind === 'groups' ? 'GROUPS' : result.kind === 'group-topics' && result.groupId ? `GROUP ${JSON.stringify(result.groupId)} TOPICS` : undefined
  return base ? `${base}${result.search !== undefined && result.kind !== 'group-topics' ? ` SEARCH ${JSON.stringify(result.search)}` : ''} CURSOR ${result.nextCursor}` : undefined
}

export function KafkaResultView({ result, onUse, snapshotScope = '', canWrite = false }: { result?: KafkaResult; onUse?(text: string): void; snapshotScope?: string; canWrite?: boolean }): React.ReactElement {
  if (!result) return <p className="db-muted db-query-result-empty">执行后在此显示 Kafka 结果。</p>
  const next = nextListCommand(result)
  const pageHint = <><p className="db-muted">列表变化可能导致重复或遗漏；需要完整重新遍历时请刷新第一页。</p>{next && onUse && <button type="button" className="db-btn" onClick={() => onUse(next)}>下一页草稿</button>}</>
  const warning = result.resultTruncated ? <p className="db-info-note">详情达到大小上限，仅显示部分信息。</p> : undefined
  if (result.kind === 'topics' || result.kind === 'group-topics') return <div className="db-kafka-results"><p className="db-muted">{result.groupId ? `${result.groupId} · ` : ''}本页 {result.topics?.length || 0} 个 Topic{result.truncated ? ' · 还有后续页' : ''}</p>
    <ul>{(result.topics || []).map(topic => <li key={topic}><button type="button" className="db-text-button" onClick={() => onUse?.(result.kind === 'group-topics' ? `GROUP ${JSON.stringify(result.groupId)} TOPIC ${JSON.stringify(topic)}` : `DESCRIBE ${JSON.stringify(topic)}`)}>{topic}</button></li>)}</ul>{pageHint}</div>
  if (result.kind === 'describe') return <>{warning}<KafkaDescribeTable topic={result.topic || ''} partitions={result.partitions || []} onUse={onUse} /></>
  if (result.kind === 'groups') return <div className="db-kafka-results"><p className="db-muted">本页 {result.groups?.length || 0} 个消费组{result.truncated ? ' · 还有后续页' : ''}</p>
    <ul>{(result.groups || []).map(groupId => <li key={groupId}><button type="button" className="db-text-button" onClick={() => onUse?.(`GROUP ${JSON.stringify(groupId)}`)}>{groupId}</button></li>)}</ul>{pageHint}</div>
  if (result.kind === 'group') return <>{warning}<KafkaGroupDetail group={{ kind: 'group', groupId: result.groupId || '', state: result.state || '', protocol: result.protocol || '', protocolType: result.protocolType || '', members: result.members || [] }} />{onUse && result.groupId && <button type="button" className="db-btn" onClick={() => onUse(`GROUP ${JSON.stringify(result.groupId)} TOPICS`)}>关联 Topic 草稿</button>}</>
  if (result.kind === 'group-topic') {
    const topic = result as unknown as KafkaGroupTopicResult
    return <>{warning}{result.warning && <p className="db-info-note">{result.warning}</p>}<KafkaGroupTopicDetail detail={{ kind: 'group-topic', groupId: topic.groupId, topic: topic.topic, state: topic.state, partitions: topic.partitions || [] }} onUse={onUse} snapshotScope={snapshotScope} canWrite={canWrite} /></>
  }
  if (result.kind === 'produce') return <div className="db-kafka-results"><p>Broker 已确认发布到 {result.topic} · 分区 {result.partition ?? '未知'}{result.baseOffset !== undefined ? ` · Offset ${result.baseOffset}` : ''}。</p>
    <p className="db-muted">Value {result.valueBytes ?? 0} B。回执不包含消息正文；发布后请按 Key 或业务标识核对消费链路。</p>
    {result.replayFrom && <p className="db-muted">修正来源：{result.replayFrom.topic} / 分区 {result.replayFrom.partition} / Offset {result.replayFrom.offset}</p>}
    {onUse && result.topic && result.partition !== undefined && result.baseOffset !== undefined && <button type="button" className="db-btn" onClick={() => onUse(`PEEK ${JSON.stringify(result.topic)} PARTITION ${result.partition} FROM OFFSET ${result.baseOffset} LIMIT 1`)}>回读此 Offset 草稿</button>}</div>
  if (result.kind === 'topic-config') return <div className="db-kafka-results"><strong>{result.topic} · Topic 配置</strong>
    <ul>{Object.entries(result.configs || {}).map(([name, item]) => <li key={name}>{name}: {item.value ?? '未知'}{item.isDefault ? '（默认）' : ''}</li>)}</ul></div>
  if (result.kind === 'time-offsets') return <div className="db-kafka-results"><p>{result.topic} · {new Date(result.timestamp || 0).toLocaleString()}</p>
    <ul>{(result.partitions as unknown as { partition: number; offset: string; noLaterMessage: boolean }[] || []).map(item => <li key={item.partition}>
      分区 {item.partition} · Offset {item.offset}{item.noLaterMessage ? ' · 该时间之后无消息，定位到末尾' : ''}
      {onUse && <button type="button" className="db-text-button" onClick={() => onUse(`PEEK ${JSON.stringify(result.topic)} PARTITION ${item.partition} FROM OFFSET ${item.offset} LIMIT 20`)}>查看</button>}
    </li>)}</ul>{onUse && result.topic && <button type="button" className="db-btn" onClick={() => {
      const parts = (result.partitions as unknown as { partition: number }[] || []).slice(0, 8).map(item => item.partition)
      if (parts.length) onUse(`SCAN ${JSON.stringify({ topic: result.topic, partitions: parts, timestamp: result.timestamp })}`)
    }}>跨分区取样草稿</button>}</div>
  if (result.kind === 'scan') return <div className="db-kafka-results"><p>{result.topic} · 已检查 {result.inspected ?? 0} 条 · 匹配 {result.messages?.length || 0} 条。</p>
    {!result.complete && <p className="db-info-note">范围未查完（{result.reason || '部分分区未读取'}）；下方续读位置仅适用于本次扫描快照。</p>}
    {onUse && !result.complete && result.nextOffsets && result.topic && result.partitions && <button type="button" className="db-btn" onClick={() => onUse(`SCAN ${JSON.stringify({ topic: result.topic, partitions: result.partitions, offsets: result.nextOffsets,
      ...(result.key !== undefined ? { key: result.key } : {}), ...(result.header !== undefined ? { header: result.header } : {}) })}`)}>下一段扫描草稿</button>}
    {(result.messages as (KafkaMessage & { partition: number })[] || []).map(message => <KafkaMessageView key={`${message.partition}/${message.offset}`} topic={result.topic || ''} partition={message.partition} message={message} onUse={onUse} canWrite={canWrite} />)}</div>
  if (result.kind === 'produce-batch') return <div className="db-kafka-results"><p>{result.topic} · 已确认 {result.receipts?.length || 0} 条 · 未发送 {result.notSent ?? 0} 条。</p>
    {result.failedIndex !== undefined && <p className="db-info-note">第 {result.failedIndex + 1} 条：{result.status === 'unknown' ? '结果未知，请先核对。' : '未确认发布。'}</p>}
    <ul>{(result.receipts || []).map(item => <li key={item.index}>第 {item.index + 1} 条 · 分区 {item.partition}{item.baseOffset ? ` · Offset ${item.baseOffset}` : ''}
      {onUse && item.baseOffset && <button type="button" className="db-text-button" onClick={() => onUse(`PEEK ${JSON.stringify(result.topic)} PARTITION ${item.partition} FROM OFFSET ${item.baseOffset} LIMIT 1`)}>回读</button>}</li>)}</ul></div>
  if (result.kind === 'tombstone') return <div className="db-kafka-results"><p>墓碑已获 Broker 确认：{result.topic} · 分区 {result.partition ?? '未知'}{result.baseOffset ? ` · Offset ${result.baseOffset}` : ''}。</p><p className="db-muted">历史记录的压缩异步发生；请按业务协议核对效果。</p></div>
  if (result.kind === 'create-topic') return <div className="db-kafka-results"><p>已创建 {result.topic} · {result.partitionCount ?? '未知'} 个分区 · {result.cleanupPolicy}。</p>{onUse && <button type="button" className="db-btn" onClick={() => onUse(`DESCRIBE ${JSON.stringify(result.topic)}`)}>查看 Topic 草稿</button>}</div>
  if (result.kind === 'set-group-offsets') return <div className="db-kafka-results"><p>{result.groupId} / {result.topic} · 位点调整后已回读。</p>
    <ul>{Object.entries(result.after || {}).map(([partition, offset]) => <li key={partition}>分区 {partition}: {result.before?.[partition] ?? '未提交'} → {offset}</li>)}</ul></div>
  if (result.kind !== 'peek') { const unsupported: never = result.kind; throw new Error(`无法显示 Kafka 结果：${unsupported}`) }
  return <div className="db-kafka-results"><p className="db-muted">{result.topic} · 分区 {result.partition} · 本次范围 [{result.start}, {result.high}) · {result.messages?.length || 0} 条 · {result.elapsedMs || 0} ms</p>
    {result.complete ? <p>已到达本次读取上界。</p> : <p className="db-info-note">读取未遍历完整范围（{result.reason === 'limit' ? '达到条数上限' : result.reason === 'bytes' ? '达到结果大小上限' : result.reason === 'deadline' ? '超过读取截止时间' : result.reason === 'cancelled' ? '已请求取消' : result.reason === 'error' ? '读取连接中断' : '读取中断'}）。LATEST 可能因压缩或 offset 空洞少于指定条数。</p>}
    <button type="button" className="db-btn" onClick={() => {
      const url = URL.createObjectURL(new Blob([kafkaExportText(result)], { type: 'application/json;charset=utf-8' }))
      try { const link = document.createElement('a'); link.href = url; link.download = 'kafka-loaded-preview.json'; link.click() }
      finally { URL.revokeObjectURL(url) }
    }}>导出当前结果 JSON</button>
    {onUse && result.topic && result.partition !== undefined && result.messages?.length && <button type="button" className="db-btn" onClick={() => {
      const last = result.messages?.at(-1)
      if (last) onUse(`PEEK ${JSON.stringify(result.topic)} PARTITION ${result.partition} FROM OFFSET ${(BigInt(last.offset) + 1n).toString()} LIMIT 20`)
    }}>下一段草稿</button>}
    <button type="button" className="db-btn" onClick={() => void navigator.clipboard.writeText(`${result.topic} / 分区 ${result.partition} / [${result.start}, ${result.high}) / ${result.messages?.length || 0} 条 / ${result.complete ? '完整' : '未查完'}`)}>复制排障摘要</button>
    {(result.messages || []).map(message => <KafkaMessageView key={message.offset} topic={result.topic || ''} partition={result.partition || 0} message={message} onUse={onUse} canWrite={canWrite} />)}
  </div>
}

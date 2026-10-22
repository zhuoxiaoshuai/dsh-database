import React, { useEffect, useRef, useState } from 'react'
import type { Connection, WorkspaceBridge } from '../../shared/workbench.ts'
import type { KafkaGroupSummary, KafkaTopicGroupsResult, KafkaPartition, KafkaGroupResult } from '../../shared/kafka-inspection.ts'
import { DbTable } from '../workspace/parts/layout/db-table.tsx'
import { KafkaResultView, type KafkaResult } from './results.tsx'
import { KafkaGroupDetail } from './group-detail.tsx'
import { kafkaLagOverZero } from './group-summary.ts'

type Context = { bridge: WorkspaceBridge; connection: Connection; refreshToken?: number }
export function useKafkaInspection<T>(bridge: WorkspaceBridge, connection: Connection, ref: string, refreshToken = 0) {
  const [value, setValue] = useState<T>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [version, setVersion] = useState(0)
  const initial = useRef(true)
  useEffect(() => {
    const controller = new AbortController()
    if (!ref || !connection.live) { setValue(undefined); return }
    setBusy(true); setError('')
    void bridge.explorer?.(connection, 'read', { ref, refresh: !initial.current || version > 0 || refreshToken > 0 }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setValue(result as T) })
      .catch(caught => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '读取失败。') })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    initial.current = false
    return () => controller.abort()
  }, [bridge, connection.id, connection.generation, connection.live, ref, version, refreshToken])
  return { value, busy, error, refresh: () => setVersion(v => v + 1) }
}

export function KafkaInspectionStatus({ busy, error, collectedAt }: { busy?: boolean; error?: string; collectedAt?: string }) {
  return <>{busy && <p role="status">正在刷新…</p>}{error && <p className="db-error" role="alert">刷新失败：{error}；已有数据为上次结果。</p>}
    {collectedAt && <p className="db-muted">采集时间：{new Date(collectedAt).toLocaleString()}</p>}</>
}

export function KafkaTopicGroups({ bridge, connection, topic, onNavigate, refreshToken = 0 }: Context & { topic: string; onNavigate(groupId: string, topic: string): void }) {
  const [pages, setPages] = useState<KafkaTopicGroupsResult[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const request = useRef<AbortController>()
  const load = async (cursor?: string, refresh = false) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller
    setBusy(true); setError('')
    try {
      const page = await bridge.explorer!(connection, 'read', { ref: `topic-groups:${encodeURIComponent(topic)}`, cursor, refresh }, controller.signal) as KafkaTopicGroupsResult
      if (!controller.signal.aborted) setPages(previous => cursor === undefined ? [page] : [...previous, page])
    } catch (caught) { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '关联查询失败。') }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  useEffect(() => { void load(undefined, refreshToken > 0); return () => request.current?.abort() }, [connection.id, connection.generation, topic, refreshToken])
  const last = pages.at(-1)
  const groups = [...new Map(pages.flatMap(page => page.associations || []).map(item => [item.groupId, item])).values()]
  const failed = pages.reduce((sum, page) => sum + (page.failed || 0), 0)
  const complete = !!last?.complete && !last.nextCursor && failed === 0 && pages.every(page => !page.resultTruncated)
  const assignedCount = groups.filter(item => item.assigned).length
  const incompleteCount = groups.filter(item => !item.complete).length
  return <div className="db-kafka-panel">
    <KafkaInspectionStatus busy={busy} error={error}/>
    {!complete && pages.length > 0 && <p className="db-info-note">结果不完整 · 已检查 {pages.reduce((sum, page) => sum + page.scanned, 0)} 个候选组 · {failed} 个组信息不完整。列表变化可能重复或遗漏。</p>}
    <div className="db-kafka-metrics">
      <div className="db-kafka-metric is-hero"><span className="db-kafka-metric-label">关联消费组</span><span className="db-kafka-metric-value">{groups.length}</span></div>
      <div className="db-kafka-metric"><span className="db-kafka-metric-label">当前分配</span><span className="db-kafka-metric-value">{assignedCount}</span></div>
      <div className={`db-kafka-metric${incompleteCount > 0 ? ' is-warn' : ''}`}><span className="db-kafka-metric-label">信息不完整</span><span className="db-kafka-metric-value">{incompleteCount}</span></div>
    </div>
    <div className="db-kafka-table-card">
      <div className="db-kafka-panel-head">
        <b>消费组关联</b>
        {last?.collectedAt && <span className="db-kafka-collected">采集时间：{new Date(last.collectedAt).toLocaleString()}</span>}
        <button className="db-text-button" disabled={busy} onClick={() => void load(undefined, true)}>刷新关联消费组</button>
      </div>
      <DbTable rows={groups} rowKey={item => item.groupId} empty={busy ? '正在查找…' : complete ? '未发现关联组。' : '尚未找到关联组，结果不完整。'} columns={[
        { key: 'groupId', title: 'Consumer Group', render: item => <button className="db-text-button" onClick={() => onNavigate(item.groupId, topic)}>{item.groupId}</button> },
        { key: 'relation', title: '关联依据', render: item => <span className="db-kafka-relation">
          {item.assigned && <span className="db-kafka-lag-ok">当前分配</span>}
          {item.assigned && item.committed && ' '}
          {item.committed && <span className="db-kafka-lag-zero">历史提交</span>}
          {!item.complete && <span className="db-kafka-lag-chip">信息不完整</span>}
        </span> },
      ]}/>
      <div className="db-kafka-foot">关联依据：当前分配 = 组内成员正持有该分区；历史提交 = 仅存在已提交位点。</div>
    </div>
    {last?.nextCursor !== undefined && <button className="db-text-button" disabled={busy} onClick={() => void load(last.nextCursor)}>继续查找关联消费组</button>}
  </div>
}

export function KafkaLagText({ value }: { value: Pick<KafkaGroupSummary, 'totalLag' | 'knownLag' | 'knownPartitions' | 'partitionCount' | 'complete'> }) {
  return <span>{value.complete && value.totalLag != null ? value.totalLag : `-（已知小计 ${value.knownLag}；覆盖 ${value.knownPartitions}/${value.partitionCount} 个已返回分区，非全部）`}</span>
}

// 组级总览指标卡：Topic 汇总与成员页签共用，保证同级页签切换指标条恒定不跳
export function KafkaGroupSummaryMetrics({ summary }: { summary?: KafkaGroupSummary }) {
  if (!summary) return null
  return <div className="db-kafka-metrics">
    <div className={`db-kafka-metric is-hero${kafkaLagOverZero(summary) ? ' is-warn' : ''}`}>
      <span className="db-kafka-metric-label">Total Lag</span>
      <span className="db-kafka-metric-value">{summary.complete && summary.totalLag != null ? summary.totalLag : <small><KafkaLagText value={summary}/></small>}</span>
    </div>
    <div className="db-kafka-metric"><span className="db-kafka-metric-label">Topics</span><span className="db-kafka-metric-value">{summary.complete ? summary.topicCount : '-'}</span></div>
    <div className="db-kafka-metric"><span className="db-kafka-metric-label">异常分区（已知）</span><span className="db-kafka-metric-value">{summary.abnormalPartitions}</span></div>
    <div className="db-kafka-metric"><span className="db-kafka-metric-label">未提交分区（已知）</span><span className="db-kafka-metric-value">{summary.uncommittedPartitions}</span></div>
  </div>
}

export function KafkaGroupTopics({ bridge, connection, groupId, onTopic, refreshToken }: Context & { groupId: string; onTopic(topic: string): void }) {
  const state = useKafkaInspection<KafkaGroupSummary>(bridge, connection, `group-summary:${encodeURIComponent(groupId)}`, refreshToken)
  const summary = state.value
  return <div className="db-kafka-panel">
    {summary?.warning && <p className="db-info-note">{summary.warning}</p>}
    {summary?.resultTruncated && <p className="db-info-note">详情达到大小上限，Topic 列表与汇总不完整。</p>}
    <KafkaInspectionStatus busy={state.busy} error={state.error}/>
    {summary && <KafkaGroupSummaryMetrics summary={summary}/>}
    {summary && <div className="db-kafka-table-card">
      <div className="db-kafka-panel-head">
        <b>Topic 消费汇总</b>
        {summary.collectedAt && <span className="db-kafka-collected">采集时间：{new Date(summary.collectedAt).toLocaleString()}</span>}
        <button className="db-text-button" disabled={state.busy} onClick={state.refresh}>刷新 Topic 消费汇总</button>
      </div>
      <DbTable rows={summary.topics} rowKey={item => item.topic} columns={[
        { key: 'topic', title: 'Topic', render: item => <button className="db-text-button" onClick={() => onTopic(item.topic)}>{item.topic}</button> },
        { key: 'assignedPartitions', title: '已分配分区' },
        { key: 'totalLag', title: 'Lag', render: item => <KafkaLagText value={item}/> },
        { key: 'abnormalPartitions', title: '异常分区（已知）' },
        { key: 'uncommittedPartitions', title: '未提交分区（已知）' },
      ]}/>
    </div>}
  </div>
}

export function KafkaGroupMembers({ bridge, connection, groupId, refreshToken, heading = true }: Context & { groupId: string; heading?: boolean }) {
  const state = useKafkaInspection<KafkaGroupResult>(bridge, connection, `group:${encodeURIComponent(groupId)}`, refreshToken)
  const summaryState = useKafkaInspection<KafkaGroupSummary>(bridge, connection, `group-summary:${encodeURIComponent(groupId)}`, refreshToken)
  return <><KafkaInspectionStatus busy={state.busy} error={state.error}/>
    <KafkaGroupSummaryMetrics summary={summaryState.value}/>
    {state.value && <KafkaGroupDetail group={state.value} heading={heading}/>}</>
}

export function KafkaTopicMessages({ bridge, connection, topic, partitions, onUse }: Context & { topic: string; partitions: KafkaPartition[]; onUse(text: string): void }) {
  const [partition, setPartition] = useState(partitions[0]?.partition ?? 0), [offset, setOffset] = useState('')
  const [result, setResult] = useState<KafkaResult>(), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const pending = useRef<AbortController>()
  useEffect(() => () => pending.current?.abort(), [connection.id, connection.generation, topic])
  const command = `PEEK ${JSON.stringify(topic)} PARTITION ${partition} FROM ${offset ? `OFFSET ${offset}` : 'LATEST'} LIMIT 20`
  const read = async () => {
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller; setBusy(true); setError('')
    try { const value = await bridge.executeText!(connection, command, {}, controller.signal); if (!controller.signal.aborted) setResult(value as KafkaResult) }
    catch (caught) { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '消息读取失败。') }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return <>
    <div className="db-kafka-table-card db-kafka-form-card">
      <div className="db-kafka-panel-head"><b>消息读取</b><span className="db-kafka-collected">临时读取 · 不提交业务位点 · 单次最多 20 条</span></div>
      <div className="db-resource-form db-kafka-form">
        <label>分区<select value={partition} onChange={event => setPartition(Number(event.target.value))}>{partitions.map(item => <option key={item.partition}>{item.partition}</option>)}</select></label>
        <label>起始 Offset（留空读取末尾）<input value={offset} onChange={event => setOffset(event.target.value)}/></label>
        <button className="db-primary" disabled={busy || !bridge.executeText || !connection.live || !partitions.length} onClick={() => void read()}>读取消息</button>
        <button className="db-text-button" onClick={() => onUse(command)}>填入读取草稿</button>
        <p className="db-muted">正文按现有上限预览。</p>
      </div>
    </div>
    <KafkaInspectionStatus busy={busy} error={error}/>
    {result && <KafkaResultView result={result} onUse={onUse} canWrite={connection.environment === 'sit'}/>}</>
}

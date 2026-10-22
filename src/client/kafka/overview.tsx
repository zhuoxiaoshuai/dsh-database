import React, { useEffect, useRef, useState } from 'react'
import {ActionMenu, ResourceHelp} from '../workspace/parts/overlay/action-menu.tsx'
import {ResourceError, ResourceHeading} from '../workspace/parts/layout/resource-list.tsx'
import { X } from 'lucide-react'
import type { Connection, WorkspaceBridge } from '../../shared/workbench.ts'
import type { ExplorerNode } from '../../shared/explorer.ts'
import { useDragResize } from '../workspace/parts/hooks/use-drag-resize.ts'
import { usePagedList } from '../workspace/parts/use-paged-list.ts'
import { createRequestScope } from '../workspace/parts/request-scope.ts'
import { SearchTree, SearchTreeNode, SearchTreeSplit } from '../workspace/tree/search-tree.tsx'
import { KafkaGroupTopicDetail } from './group-detail.tsx'
import { KafkaDescribeTable } from './describe-table.tsx'
import {kafkaInternalTopic, kafkaPeekCommand, type KafkaPartitionRow} from './describe.ts'
import type { KafkaGroupResult, KafkaGroupTopicResult } from './results.tsx'
import type { KafkaNames } from './completion.ts'
import { KafkaTopicGroups, KafkaTopicMessages, KafkaGroupTopics, KafkaGroupMembers, KafkaLagText } from './inspection-panels.tsx'
import type { KafkaGroupSummary } from '../../shared/kafka-inspection.ts'
import { kafkaLagOverZero, kafkaStateTone } from './group-summary.ts'

type Mode = 'topics' | 'groups'
type TopicDetail = { kind?: string; topic?: string; partitions?: KafkaPartitionRow[] }

function asGroup(value: TopicDetail | KafkaGroupResult | KafkaGroupTopicResult | undefined): KafkaGroupResult | undefined {
  if (!value || value.kind !== 'group' || !('members' in value)) return undefined
  return value
}
function asGroupTopic(value: TopicDetail | KafkaGroupResult | KafkaGroupTopicResult | undefined): KafkaGroupTopicResult | undefined {
  if (!value || value.kind !== 'group-topic' || !('groupId' in value)) return undefined
  return value
}
function dedupe(nodes: ExplorerNode[]): ExplorerNode[] {
  const seen = new Set<string>()
  return nodes.filter(node => seen.has(node.ref) ? false : (seen.add(node.ref), true))
}
function explorerItems(page: { nodes?: ExplorerNode[] } | null | undefined): ExplorerNode[] {
  return Array.isArray(page?.nodes) ? page.nodes : []
}
// Topic 树节点健康状态 → 徽章色调（与消费组状态徽章体系统一）
function kafkaHealthTone(health: unknown): string {
  const value = String(health ?? '未知')
  return value === '正常' ? 'ok' : value === '异常' ? 'error' : 'idle'
}

export function KafkaOverview({ bridge, connection, catalog = 'topics', refreshToken = 0, onUse, onNames, active = true, jump, onNavigate, onReturn }: {
  bridge: WorkspaceBridge
  connection: Connection
  catalog?: Mode
  refreshToken?: number
  onUse(text: string): void
  onNames?(names: Partial<KafkaNames>): void
  active?: boolean
  jump?: { groupId: string; topic: string; sequence: number }
  onNavigate?(groupId: string, topic: string): void
  onReturn?(): void
}): React.ReactElement {
  const mode: Mode = catalog === 'groups' ? 'groups' : 'topics'
  const [topicSearch, setTopicSearch] = useState('')
  const [groupSearch, setGroupSearch] = useState('')
  const [selected, setSelected] = useState<ExplorerNode>()
  const [detail, setDetail] = useState<TopicDetail | KafkaGroupResult | KafkaGroupTopicResult>()
  const [detailError, setDetailError] = useState('')
  const [detailBusy, setDetailBusy] = useState(false)
  const [topicTab, setTopicTab] = useState('partitions')
  const [groupTab, setGroupTab] = useState('topics')
  const [detailVersion, setDetailVersion] = useState(0)
  const [summaries, setSummaries] = useState<Record<string, KafkaGroupSummary>>({})
  const [summaryBusy, setSummaryBusy] = useState(false)
  const [summaryError, setSummaryError] = useState('')
  const [listWarning, setListWarning] = useState('')
  const [children, setChildren] = useState<Record<string, ExplorerNode[]>>({})
  const [childError, setChildError] = useState<Record<string, string>>({})
  const [childCursor, setChildCursor] = useState<Record<string, string | undefined>>({})
  const [childBusy, setChildBusy] = useState<Record<string, boolean>>({})
  const [treeWidth, setTreeWidth] = useState(220)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [publishKey, setPublishKey] = useState('')
  const [publishValue, setPublishValue] = useState('')
  const [publishEncoding, setPublishEncoding] = useState<'utf8' | 'base64'>('utf8')
  const [publishHeaders, setPublishHeaders] = useState('{}')
  const [createName, setCreateName] = useState('dsh-test-')
  const [createPartitions, setCreatePartitions] = useState(1)
  const [createReplication, setCreateReplication] = useState(1)
  const [createCleanup, setCreateCleanup] = useState<'delete' | 'compact'>('delete')
  const [batchMessages, setBatchMessages] = useState('[{"value":""}]')
  const [tombstoneKey, setTombstoneKey] = useState('')
  const [operation, setOperation] = useState('scan')
  const [scanPartitions, setScanPartitions] = useState('0')
  const [scanTime, setScanTime] = useState('')
  const [scanKey, setScanKey] = useState('')
  const [scanHeaderName, setScanHeaderName] = useState('')
  const [scanHeaderValue, setScanHeaderValue] = useState('')
  const topicSearchRef = useRef('')
  const groupSearchRef = useRef('')
  const groupPage = useRef<ExplorerNode[]>([])
  const connectionRef = useRef(connection)
  const childLoading = useRef(new Set<string>())
  const identity = `${connection.id}\0${connection.generation || ''}\0${mode}`
  const loaded = useRef('')
  const scope = useRef(createRequestScope(identity))
  const detailTicket = useRef<ReturnType<typeof scope.current.begin>>()
  const identityRef = useRef(identity)
  if (identityRef.current !== identity) { scope.current.invalidate(identity); identityRef.current = identity }
  topicSearchRef.current = topicSearch
  groupSearchRef.current = groupSearch
  connectionRef.current = connection
  const startResize = useDragResize((start, next) => setTreeWidth(Math.min(320, Math.max(180, treeWidth + (next.clientX - start.clientX)))))
  const loadTopics = async (cursor: string | undefined, signal: AbortSignal) => {
    if (!bridge.explorer) throw new Error('Kafka 对象读取通道不可用。')
    const page = await bridge.explorer(connection, 'list', { cursor, search: topicSearchRef.current }, signal)
    if (!signal.aborted) setListWarning(page.warning || '')
    if (!signal.aborted && connectionRef.current.id === connection.id && connectionRef.current.generation === connection.generation) onNames?.({ topics: explorerItems(page).map(item => item.title) })
    return { items: explorerItems(page), nextCursor: page.nextCursor }
  }
  const loadGroups = async (cursor: string | undefined, signal: AbortSignal) => {
    if (!bridge.explorer) throw new Error('Kafka 对象读取通道不可用。')
    const page = await bridge.explorer(connection, 'list', { parent: 'folder:groups', cursor, search: groupSearchRef.current }, signal)
    if (!signal.aborted) groupPage.current = explorerItems(page)
    if (!signal.aborted) setListWarning(page.warning || '')
    if (!signal.aborted && connectionRef.current.id === connection.id && connectionRef.current.generation === connection.generation) onNames?.({ groups: explorerItems(page).map(item => item.title) })
    return { items: explorerItems(page), nextCursor: page.nextCursor }
  }
  const topics = usePagedList(loadTopics, identity)
  const groups = usePagedList(loadGroups, identity)
  const topicsReplace = topics.replace
  const groupsReplace = groups.replace
  const topicsReset = topics.reset
  const groupsReset = groups.reset

  const resetDetails = () => {
    scope.current.invalidate(identity)
    childLoading.current.clear()
    if (detailTicket.current) scope.current.cancel(detailTicket.current)
    setSelected(undefined); setDetail(undefined); setDetailError(''); setDetailBusy(false)
    setChildren({}); setChildError({}); setChildCursor({}); setChildBusy({})
  }

  useEffect(() => {
    if (!active || loaded.current === identity && connection.live) return
    loaded.current = connection.live ? identity : ''
    resetDetails()
    setSummaries({})
    setDrawerOpen(false)
    if (detailTicket.current) scope.current.cancel(detailTicket.current)
    if (!connection.live) {
      topicsReset()
      groupsReset()
      return
    }
    if (mode === 'groups') {
      topicsReset()
      void groupsReplace()
    } else {
      groupsReset()
      void topicsReplace()
    }
  }, [connection.id, connection.generation, connection.live, mode, active, topicsReplace, groupsReplace, topicsReset, groupsReset])
  useEffect(() => () => {
      topicsReset()
      groupsReset()
      if (detailTicket.current) scope.current.cancel(detailTicket.current)
      scope.current.invalidate(identity)
      childLoading.current.clear()
  }, [identity])

  const open = async (node: ExplorerNode, refresh = false) => {
    if (!bridge.explorer) return
    if (detailTicket.current) scope.current.cancel(detailTicket.current)
    const ticket = scope.current.latest('detail')
    detailTicket.current = ticket
    setSelected(node)
    if (!refresh) { setDetail(undefined); setTopicTab('partitions'); setGroupTab('topics') }
    else setDetailVersion(value => value + 1)
    setDrawerOpen(false)
    setDetailBusy(true)
    setDetailError('')
    try {
      const read = await bridge.explorer(connection, 'read', { ref: node.ref, refresh }, ticket.signal) as TopicDetail | KafkaGroupResult | KafkaGroupTopicResult
      if (scope.current.isCurrent(ticket) && !ticket.signal.aborted) setDetail(read)
    } catch (caught) {
      if (scope.current.isCurrent(ticket) && !ticket.signal.aborted) setDetailError(caught instanceof Error ? caught.message : '详情读取失败。')
    } finally {
      if (scope.current.isCurrent(ticket)) setDetailBusy(false)
      scope.current.finish(ticket)
    }
  }
  useEffect(() => {
    if (mode === 'groups' && jump) void open({ ref: `gtopic:${encodeURIComponent(jump.groupId)}:${encodeURIComponent(jump.topic)}`, title: jump.topic, kind: 'group-topic', hasChildren: false, metadata: { groupId: jump.groupId, topic: jump.topic } })
  }, [jump?.sequence])
  useEffect(() => {
    if (refreshToken > 0 && active) {
      scope.current.invalidate(identity); childLoading.current.clear()
      setChildren({}); setChildCursor({}); setChildBusy({}); setChildError({}); setSummaryBusy(false)
      if (mode === 'groups') void groupsReplace(); else void topicsReplace()
      if (selected) void open(selected, true)
    }
  }, [refreshToken])
  const loadChildren = async (node: ExplorerNode, append = false) => {
    if (!bridge.explorer || (!append && children[node.ref]) || childLoading.current.has(node.ref)) return
    childLoading.current.add(node.ref)
    const ticket = scope.current.begin()
    const current = connectionRef.current
    setChildBusy(previous => ({ ...previous, [node.ref]: true }))
    setChildError(previous => ({ ...previous, [node.ref]: '' }))
    try {
      const page = await bridge.explorer(current, 'list', { parent: node.ref, ...(append ? { cursor: childCursor[node.ref] } : {}) }, ticket.signal)
      if (!scope.current.isCurrent(ticket)) return
      setChildren(previous => ({ ...previous, [node.ref]: dedupe([...(append ? previous[node.ref] || [] : []), ...page.nodes]) }))
      setChildCursor(previous => ({ ...previous, [node.ref]: page.nextCursor }))
      if (page.warning || page.complete === false && !page.nextCursor) setChildError(previous => ({ ...previous, [node.ref]: page.warning || '关联 Topic 信息不完整。' }))
      onNames?.({ topics: page.nodes.map(item => item.title) })
    } catch (caught) {
      if (scope.current.isCurrent(ticket)) {
        setChildError(previous => ({ ...previous, [node.ref]: caught instanceof Error ? caught.message : '关联 Topic 读取失败。' }))
      }
    } finally {
      if (scope.current.isCurrent(ticket)) { childLoading.current.delete(node.ref); setChildBusy(previous => ({ ...previous, [node.ref]: false })) }
      scope.current.finish(ticket)
    }
  }
  const topicNodes = dedupe(topics.items)
  const groupNodes = dedupe(groups.items)
  const list = mode === 'topics' ? topics : groups
  const groupDetail = asGroup(detail)
  const groupTopicDetail = asGroupTopic(detail)
  const topicDetail = detail && !('groupId' in detail) ? detail : undefined
  const partitions = topicDetail?.partitions || []
  const topicName = selected?.kind === 'topic' ? selected.title : ''
  const groupId = groupDetail?.groupId || groupTopicDetail?.groupId || String(selected?.metadata?.groupId || '')
  const openGroupTopic = (topic: string) => void open({ ref: `gtopic:${encodeURIComponent(groupId)}:${encodeURIComponent(topic)}`, title: topic, kind: 'group-topic', hasChildren: false, metadata: { groupId, topic } })
  const loadSummaries = async () => {
    if (!bridge.explorer || summaryBusy) return
    const ticket = scope.current.latest('summaries'); setSummaryBusy(true); setSummaryError('')
    let index = 0
    const pageNodes = [...groupPage.current]
    try {
      await Promise.all(Array.from({ length: Math.min(4, pageNodes.length) }, async () => {
        while (index < pageNodes.length && scope.current.isCurrent(ticket)) {
          const node = pageNodes[index++]
          try {
            const result = await bridge.explorer!(connection, 'read', { ref: `group-summary:${encodeURIComponent(node.title)}`, refresh: true }, ticket.signal) as KafkaGroupSummary
            if (scope.current.isCurrent(ticket)) setSummaries(previous => ({ ...previous, [node.title]: result }))
          } catch (error) { if (scope.current.isCurrent(ticket)) setSummaryError(error instanceof Error ? error.message : '部分组汇总失败。') }
        }
      }))
    } finally { if (scope.current.isCurrent(ticket)) setSummaryBusy(false); scope.current.finish(ticket) }
  }

  const paneTitle = selected?.kind === 'topic' ? topicName
    : selected?.kind === 'group' ? (groupDetail?.groupId || selected.title)
    : selected?.kind === 'group-topic' && !groupTopicDetail ? selected.title
    : undefined
  // 组内 Topic 详情：标题渲染为可点击面包屑（组名返回组详情，替代原「分区消费」页签入口）
  const headingTitle: React.ReactNode = groupTopicDetail
    ? <><button type="button" className="db-text-button" aria-label={`返回消费组 ${groupTopicDetail.groupId}`} onClick={() => void open({ ref: `group:${encodeURIComponent(groupTopicDetail.groupId)}`, title: groupTopicDetail.groupId, kind: 'group', hasChildren: true, metadata: { groupId: groupTopicDetail.groupId } })}>{groupTopicDetail.groupId}</button><span className="db-muted"> / {groupTopicDetail.topic}</span></>
    : paneTitle
  const showCommand = () => {
    if (selected?.kind === 'topic' && topicName) onUse(`DESCRIBE ${JSON.stringify(topicName)}`)
    else if (selected?.kind === 'group' && groupDetail) onUse(`GROUP ${JSON.stringify(groupDetail.groupId)}`)
    else if (selected?.kind === 'group-topic' && groupTopicDetail) onUse(`GROUP ${JSON.stringify(groupTopicDetail.groupId)} TOPIC ${JSON.stringify(groupTopicDetail.topic)}`)
  }

  return <SearchTreeSplit open={drawerOpen} onOpenChange={setDrawerOpen} openLabel={mode === 'groups' ? '打开消费组列表' : '打开 Topic 列表'} toggle={mode === 'groups' ? '消费组' : 'Topic'}
    tree={<SearchTree label={mode === 'groups' ? '搜索消费组' : '搜索 Kafka Topic'} refreshLabel="刷新" width={treeWidth} onResize={startResize}
      title={mode === 'groups' ? '消费组' : 'Topics'}
      action={<button type="button" className="db-search-tree-close db-icon-button" aria-label={mode === 'groups' ? '关闭消费组列表' : '关闭 Topic 列表'} onClick={() => setDrawerOpen(false)}><X size={13} /></button>}
      search={mode === 'groups' ? groupSearch : topicSearch}
      onSearch={mode === 'groups' ? setGroupSearch : setTopicSearch}
      onSubmitSearch={() => { resetDetails(); if (mode === 'groups') void groups.replace(); else void topics.replace() }}
      onRefresh={() => { if (mode === 'groups') void groups.replace(); else void topics.replace() }}
      busy={list.loading} disabled={!connection.live} error={list.error}
      empty={<p className="db-muted">{list.loading ? '正在读取…' : (mode === 'groups' ? '没有可见的消费组。' : '没有可见的 Topic。')}</p>}
      footer={list.nextCursor ? <button type="button" className="db-text-button" disabled={list.loading} onClick={() => void list.append()}>{mode === 'groups' ? '加载更多消费组' : '加载更多 Topic'}</button> : undefined}>
      {listWarning && <p className="db-info-note">{listWarning}</p>}
      {mode === 'groups' && <><button className="db-text-button" disabled={summaryBusy} onClick={() => void loadSummaries()}>{summaryBusy ? '正在加载消费汇总…' : '加载本页消费汇总'}</button>{summaryError && <p className="db-error">{summaryError}</p>}</>}
      {mode === 'topics' ? topicNodes.map(node => <SearchTreeNode key={node.ref} text={node.title} selected={selected?.ref === node.ref} onSelect={() => void open(node)}
        trailing={<>
          {kafkaInternalTopic(node.title) && <span className="db-kafka-state is-info">系统</span>}
          <span className={`db-kafka-state is-${kafkaHealthTone(node.metadata?.health)}`}>{String(node.metadata?.health ?? '未知')}</span>
          <small className="db-kafka-members">{String(node.metadata?.partitionCount ?? '-')}P·{String(node.metadata?.replicationFactor ?? '-')}R</small>
        </>}/>)
        : groupNodes.map(node => <React.Fragment key={node.ref}><SearchTreeNode folder text={node.title} selected={selected?.ref === node.ref} onSelect={() => void open(node)} onOpen={() => void loadChildren(node)}
          trailing={<><span className={`db-kafka-state is-${kafkaStateTone(node.metadata?.state)}`}>{String(node.metadata?.state ?? '未知')}</span><small className="db-kafka-members">({String(node.metadata?.members ?? '-')})</small></>}>
          {(children[node.ref] || []).map(child => <SearchTreeNode key={child.ref} text={child.title} depth={1} selected={selected?.ref === child.ref} onSelect={() => void open(child)} />)}
          {childCursor[node.ref] && <button type="button" className="db-text-button" disabled={childBusy[node.ref]} onClick={() => void loadChildren(node, true)}>加载更多关联 Topic</button>}
          {childBusy[node.ref] && <p className="db-muted">正在读取关联 Topic…</p>}
          {childError[node.ref] && <p className="db-error" role="alert">{childError[node.ref]}</p>}
        </SearchTreeNode>{kafkaLagOverZero(summaries[node.title]) && <p className="db-kafka-lag-chip">Lag <KafkaLagText value={summaries[node.title]}/></p>}</React.Fragment>)}
    </SearchTree>}
    detail={<section className="db-kafka-overview-detail">
      {onReturn && <button className="db-text-button" style={{alignSelf:'flex-start'}} onClick={onReturn}>返回来源 Topic</button>}
      <ResourceHeading title={headingTitle || (mode === 'groups' ? '消费组总览' : 'Topic 总览')}
        summary={selected?.kind === 'topic' && partitions.length > 0 ? `${partitions.length} 个分区 · 副本因子 ${[...new Set(partitions.map(p => p.replicas?.length ?? 0))].join('/')}` : undefined}
        actions={selected ? <>
          <button className="db-text-button" disabled={detailBusy} onClick={() => selected && void open(selected, true)}>刷新当前详情</button>
          {selected?.kind === 'topic' && partitions.length > 0 && <><button type="button" className="db-primary" onClick={()=>onUse(kafkaPeekCommand(topicName,partitions[0].partition))}>读取消息草稿</button><ResourceHelp label="消息读取说明">临时消费组读取，不提交业务消费位置。点击分区可填入对应读取草稿。</ResourceHelp></>}
          <ActionMenu label="更多 Kafka 操作"><button type="button" role="menuitem" onClick={showCommand}>查看命令</button>
            {selected?.kind === 'topic' && <><button role="menuitem" onClick={() => onUse(`TOPIC_CONFIG ${JSON.stringify(topicName)}`)}>查看 Topic 配置草稿</button>
              <button role="menuitem" onClick={() => onUse(`TIME_OFFSETS ${JSON.stringify({topic: topicName, timestamp: Date.now()})}`)}>按时间定位草稿</button>
              {connection.environment === 'sit' && <button role="menuitem" onClick={() => onUse(`PRODUCE ${JSON.stringify({topic: topicName, value: ''})}`)}>发布单条消息草稿</button>}</>}
          </ActionMenu></> : undefined}/>

      {selected?.kind === 'topic' && kafkaInternalTopic(topicName) && <p className="db-kafka-system-row"><span className="db-kafka-state is-info">系统 Topic</span><span className="db-muted">Kafka 内部 Topic，请勿直接消费或修改。</span></p>}
      {detailError && <ResourceError message={detailError}/>}
      {detailBusy && detail && <p role="status">正在刷新…</p>}
      {(detail as { resultTruncated?: boolean } | undefined)?.resultTruncated && <p className="db-info-note">详情达到大小上限，仅显示部分信息。</p>}
      {(detail as { warning?: string } | undefined)?.warning && <p className="db-info-note">{(detail as { warning: string }).warning}</p>}
      {!selected && <p className="db-muted">{mode === 'groups' ? '选择消费组查看成员，或展开后查看某个 Topic 的消费进度。' : '选择 Topic 查看分区、Leader、水位和副本。'}</p>}
      {!selected && mode === 'topics' && connection.environment === 'sit' && <details className="db-resource-disclosure"><summary>创建 SIT 测试 Topic</summary>
        <div className="db-resource-form db-kafka-form"><label>名称<input value={createName} onChange={event => setCreateName(event.target.value)} /></label>
          <label>分区数<input type="number" min={1} max={32} value={createPartitions} onChange={event => setCreatePartitions(Number(event.target.value))} /></label>
          <label>复制因子<input type="number" min={1} max={3} value={createReplication} onChange={event => setCreateReplication(Number(event.target.value))} /></label>
          <label>清理策略<select value={createCleanup} onChange={event => setCreateCleanup(event.target.value as 'delete' | 'compact')}><option value="delete">delete</option><option value="compact">compact</option></select></label>
          <button type="button" className="db-primary" onClick={() => onUse(`CREATE_TOPIC ${JSON.stringify({ topic: createName, partitions: createPartitions, replicationFactor: createReplication, cleanupPolicy: createCleanup })}`)}>填入创建草稿</button></div>
      </details>}
      {selected?.kind === 'topic' && <>
        <div className="db-catalog-tools db-kafka-tabs" role="group" aria-label="Topic 详情页签">{[['partitions','分区'],['messages','消息'],['groups','关联消费组']].map(([tab,label]) => <button className="db-text-button" aria-pressed={topicTab===tab} key={tab} onClick={()=>setTopicTab(tab)}>{label}</button>)}</div>
        <div hidden={topicTab !== 'partitions'}>
        {detailBusy && !partitions.length
          ? <p className="db-muted">正在读取分区…</p>
          : <KafkaDescribeTable topic={topicName} partitions={partitions} onUse={onUse} heading={false} collectedAt={(detail as { collectedAt?: string })?.collectedAt} />}</div>
        {topicTab === 'groups' && <KafkaTopicGroups key={topicName} bridge={bridge} connection={connection} topic={topicName} refreshToken={detailVersion} onNavigate={onNavigate || (()=>{})}/>}
        {topicTab === 'messages' && <KafkaTopicMessages key={topicName} bridge={bridge} connection={connection} topic={topicName} partitions={partitions} onUse={onUse}/>}
        <details className="db-resource-disclosure db-kafka-tools"><summary>操作</summary>
          <div className="db-kafka-operation-picker"><label className="db-resource-inline-field">操作类型<select aria-label="Kafka 操作类型" value={operation} onChange={event => setOperation(event.target.value)}><option value="scan">跨分区有界扫描</option>{connection.environment === 'sit' && <><option value="produce">发布单条消息</option><option value="batch">限量批量发布</option><option value="tombstone">发布压缩墓碑</option></>}</select></label></div>
          <div hidden={operation !== 'scan'}><div className="db-resource-form db-kafka-form">
          <label>分区（逗号分隔，最多 8 个）<input value={scanPartitions} onChange={event => setScanPartitions(event.target.value)} /></label>
          <label>起始时间<input type="datetime-local" value={scanTime} onChange={event => setScanTime(event.target.value)} /></label>
          <label>Key 精确匹配（可空）<input value={scanKey} onChange={event => setScanKey(event.target.value)} /></label>
          <label>Header 名称（可空）<input value={scanHeaderName} onChange={event => setScanHeaderName(event.target.value)} /></label>
          {scanHeaderName && <label>Header 值<input value={scanHeaderValue} onChange={event => setScanHeaderValue(event.target.value)} /></label>}
          <button type="button" className="db-primary" onClick={() => {
            const partitions = scanPartitions.split(',').map(item => Number(item.trim()))
            onUse(`SCAN ${JSON.stringify({ topic: topicName, partitions, timestamp: Date.parse(scanTime),
              ...(scanKey ? { key: scanKey } : {}), ...(scanHeaderName ? { header: { name: scanHeaderName, value: scanHeaderValue } } : {}) })}`)
          }}>填入扫描草稿</button></div></div>
        {connection.environment === 'sit' && <div hidden={operation !== 'produce'}><div className="db-resource-form db-kafka-form">
          <label>Key<input value={publishKey} onChange={event => setPublishKey(event.target.value)} /></label>
          <label>Value 格式<select value={publishEncoding} onChange={event => setPublishEncoding(event.target.value as 'utf8' | 'base64')}><option value="utf8">UTF-8</option><option value="base64">Base64 原始字节</option></select></label>
          <label>Value<textarea value={publishValue} onChange={event => setPublishValue(event.target.value)} /></label>
          <label>Headers JSON<textarea value={publishHeaders} onChange={event => setPublishHeaders(event.target.value)} /></label>
          <p className="db-muted">草稿会保存在共编文档中；单条解码后最多 64 KiB。</p>
          <button type="button" className="db-primary" onClick={() => {
            try { const headers = JSON.parse(publishHeaders); onUse(`PRODUCE ${JSON.stringify({ topic: topicName,
              ...(publishKey ? { key: publishKey } : {}), value: publishEncoding === 'base64' ? { base64: publishValue } : publishValue, headers })}`) }
            catch { setDetailError('Headers 必须是有效 JSON 对象。') }
          }}>填入发布草稿</button></div></div>}
        {connection.environment === 'sit' && <div hidden={operation !== 'batch'}><div className="db-resource-form db-kafka-form">
          <label>消息数组 JSON（最多 10 条）<textarea value={batchMessages} onChange={event => setBatchMessages(event.target.value)} /></label>
          <button type="button" className="db-primary" onClick={() => { try { onUse(`PRODUCE_BATCH ${JSON.stringify({ topic: topicName, messages: JSON.parse(batchMessages) })}`) }
            catch { setDetailError('批量消息必须是有效 JSON 数组。') } }}>填入批量草稿</button></div></div>}
        {connection.environment === 'sit' && <div hidden={operation !== 'tombstone'}><div className="db-resource-form db-kafka-form">
          <p className="db-muted">仅 compact Topic；Broker 确认发布不代表历史消息已立即清理。</p>
          <label>Key<input value={tombstoneKey} onChange={event => setTombstoneKey(event.target.value)} /></label>
          <button type="button" className="db-primary" onClick={() => onUse(`TOMBSTONE ${JSON.stringify({ topic: topicName, key: tombstoneKey })}`)}>填入墓碑草稿</button>
        </div></div>}</details>
      </>}
      {groupId && <><div className="db-catalog-tools db-kafka-tabs" role="group" aria-label="消费组详情页签">{[['topics','Topic 汇总'],['members','成员']].map(([tab,label]) => <button className="db-text-button" aria-pressed={!groupTopicDetail && groupTab===tab} key={tab} onClick={()=>{ setGroupTab(tab); if (groupTopicDetail) void open({ ref: `group:${encodeURIComponent(groupTopicDetail.groupId)}`, title: groupTopicDetail.groupId, kind: 'group', hasChildren: true, metadata: { groupId: groupTopicDetail.groupId } }) }}>{label}</button>)}</div>
        {!groupTopicDetail && groupTab === 'topics' && <KafkaGroupTopics key={groupId} bridge={bridge} connection={connection} groupId={groupId} onTopic={openGroupTopic} refreshToken={detailVersion}/>}
        {!groupTopicDetail && groupTab === 'members' && <KafkaGroupMembers key={groupId} bridge={bridge} connection={connection} groupId={groupId} refreshToken={detailVersion} heading={false}/>}
        {groupTopicDetail && <KafkaGroupTopicDetail detail={groupTopicDetail} heading={false} onUse={onUse} snapshotScope={`${connection.id}\0${connection.generation || ''}`} canWrite={connection.environment === 'sit'}/>}
      </>}
    </section>} />
}

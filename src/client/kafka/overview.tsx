import React, { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { Connection, WorkspaceBridge } from '../../shared/workbench.ts'
import type { ExplorerNode } from '../../shared/explorer.ts'
import { useDragResize } from '../workspace/parts/use-drag-resize.ts'
import { usePagedList } from '../workspace/parts/use-paged-list.ts'
import { createRequestScope } from '../workspace/parts/request-scope.ts'
import { SearchTree, SearchTreeNode, SearchTreeSplit } from '../workspace/tree/search-tree.tsx'
import { KafkaGroupDetail, KafkaGroupTopicDetail } from './group-detail.tsx'
import { KafkaDescribeTable } from './describe-table.tsx'
import type { KafkaPartitionRow } from './describe.ts'
import type { KafkaGroupResult, KafkaGroupTopicResult } from './results.tsx'
import type { KafkaNames } from './completion.ts'

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

export function KafkaOverview({ bridge, connection, catalog = 'topics', refreshToken = 0, onUse, onNames }: {
  bridge: WorkspaceBridge
  connection: Connection
  catalog?: Mode
  refreshToken?: number
  onUse(text: string): void
  onNames?(names: Partial<KafkaNames>): void
}): React.ReactElement {
  const mode: Mode = catalog === 'groups' ? 'groups' : 'topics'
  const [topicSearch, setTopicSearch] = useState('')
  const [groupSearch, setGroupSearch] = useState('')
  const [selected, setSelected] = useState<ExplorerNode>()
  const [detail, setDetail] = useState<TopicDetail | KafkaGroupResult | KafkaGroupTopicResult>()
  const [detailError, setDetailError] = useState('')
  const [detailBusy, setDetailBusy] = useState(false)
  const [children, setChildren] = useState<Record<string, ExplorerNode[]>>({})
  const [childError, setChildError] = useState<Record<string, string>>({})
  const [childCursor, setChildCursor] = useState<Record<string, string | undefined>>({})
  const [childBusy, setChildBusy] = useState<Record<string, boolean>>({})
  const [treeWidth, setTreeWidth] = useState(260)
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
  const [scanPartitions, setScanPartitions] = useState('0')
  const [scanTime, setScanTime] = useState('')
  const [scanKey, setScanKey] = useState('')
  const [scanHeaderName, setScanHeaderName] = useState('')
  const [scanHeaderValue, setScanHeaderValue] = useState('')
  const topicSearchRef = useRef('')
  const groupSearchRef = useRef('')
  const connectionRef = useRef(connection)
  const childLoading = useRef(new Set<string>())
  const detailToken = useRef(0)
  const detailAbort = useRef<AbortController | null>(null)
  const identity = `${connection.id}\0${connection.generation || ''}\0${mode}\0${refreshToken}`
  const scope = useRef(createRequestScope(identity))
  const identityRef = useRef(identity)
  if (identityRef.current !== identity) { scope.current.invalidate(identity); identityRef.current = identity }
  topicSearchRef.current = topicSearch
  groupSearchRef.current = groupSearch
  connectionRef.current = connection
  const startResize = useDragResize((start, next) => setTreeWidth(Math.min(480, Math.max(180, treeWidth + (next.clientX - start.clientX)))))
  const loadTopics = async (cursor: string | undefined, signal: AbortSignal) => {
    if (!bridge.explorer) throw new Error('Kafka 对象读取通道不可用。')
    const page = await bridge.explorer(connection, 'list', { cursor, search: topicSearchRef.current }, signal)
    if (!signal.aborted && connectionRef.current.id === connection.id && connectionRef.current.generation === connection.generation) onNames?.({ topics: explorerItems(page).map(item => item.title) })
    return { items: explorerItems(page), nextCursor: page.nextCursor }
  }
  const loadGroups = async (cursor: string | undefined, signal: AbortSignal) => {
    if (!bridge.explorer) throw new Error('Kafka 对象读取通道不可用。')
    const page = await bridge.explorer(connection, 'list', { parent: 'folder:groups', cursor, search: groupSearchRef.current }, signal)
    if (!signal.aborted && connectionRef.current.id === connection.id && connectionRef.current.generation === connection.generation) onNames?.({ groups: explorerItems(page).map(item => item.title) })
    return { items: explorerItems(page), nextCursor: page.nextCursor }
  }
  const topics = usePagedList(loadTopics)
  const groups = usePagedList(loadGroups)
  const topicsReplace = topics.replace
  const groupsReplace = groups.replace
  const topicsReset = topics.reset
  const groupsReset = groups.reset

  const resetDetails = () => {
    scope.current.invalidate(identity)
    childLoading.current.clear()
    detailAbort.current?.abort(); detailToken.current += 1
    setSelected(undefined); setDetail(undefined); setDetailError(''); setDetailBusy(false)
    setChildren({}); setChildError({}); setChildCursor({}); setChildBusy({})
  }

  useEffect(() => {
    resetDetails()
    setDrawerOpen(false)
    detailAbort.current?.abort()
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
    return () => {
      topicsReset()
      groupsReset()
      detailAbort.current?.abort()
      detailToken.current += 1
      scope.current.invalidate(identity)
      childLoading.current.clear()
    }
  }, [connection.id, connection.generation, connection.live, mode, refreshToken, topicsReplace, groupsReplace, topicsReset, groupsReset])

  const open = async (node: ExplorerNode) => {
    if (!bridge.explorer) return
    const current = ++detailToken.current
    detailAbort.current?.abort()
    const controller = new AbortController()
    const ticket = scope.current.begin()
    detailAbort.current = controller
    setSelected(node)
    setDetail(undefined)
    setDrawerOpen(false)
    setDetailBusy(true)
    setDetailError('')
    try {
      const read = await bridge.explorer(connection, 'read', { ref: node.ref }, controller.signal) as TopicDetail | KafkaGroupResult | KafkaGroupTopicResult
      if (scope.current.isCurrent(ticket) && current === detailToken.current && !controller.signal.aborted) setDetail(read)
    } catch (caught) {
      if (scope.current.isCurrent(ticket) && current === detailToken.current && !controller.signal.aborted) setDetailError(caught instanceof Error ? caught.message : '详情读取失败。')
    } finally {
      if (scope.current.isCurrent(ticket) && current === detailToken.current) setDetailBusy(false)
      scope.current.finish(ticket)
    }
  }
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

  const paneTitle = selected?.kind === 'topic' ? topicName
    : selected?.kind === 'group' ? (groupDetail?.groupId || selected.title)
    : selected?.kind === 'group-topic' ? (groupTopicDetail ? `${groupTopicDetail.groupId} / ${groupTopicDetail.topic}` : selected.title)
    : undefined
  const showCommand = () => {
    if (selected?.kind === 'topic' && topicName) onUse(`DESCRIBE ${JSON.stringify(topicName)}`)
    else if (selected?.kind === 'group' && groupDetail) onUse(`GROUP ${JSON.stringify(groupDetail.groupId)}`)
    else if (selected?.kind === 'group-topic' && groupTopicDetail) onUse(`GROUP ${JSON.stringify(groupTopicDetail.groupId)} TOPIC ${JSON.stringify(groupTopicDetail.topic)}`)
  }
  const commandReady = (selected?.kind === 'topic' && !!topicName) || (selected?.kind === 'group' && !!groupDetail) || (selected?.kind === 'group-topic' && !!groupTopicDetail)

  return <SearchTreeSplit open={drawerOpen} onOpenChange={setDrawerOpen} openLabel={mode === 'groups' ? '打开消费组列表' : '打开 Topic 列表'} toggle={mode === 'groups' ? '消费组' : 'Topic'}
    title={paneTitle}
    actions={commandReady ? <button type="button" className="db-btn" onClick={showCommand}>查看命令</button> : undefined}
    tree={<SearchTree label={mode === 'groups' ? '搜索消费组' : '搜索 Kafka Topic'} refreshLabel="刷新" width={treeWidth} onResize={startResize}
      title={mode === 'groups' ? '消费组' : 'Topics'}
      action={<button type="button" className="db-search-tree-close db-icon-button" aria-label={mode === 'groups' ? '关闭消费组列表' : '关闭 Topic 列表'} onClick={() => setDrawerOpen(false)}><X size={13} /></button>}
      search={mode === 'groups' ? groupSearch : topicSearch}
      onSearch={mode === 'groups' ? setGroupSearch : setTopicSearch}
      onSubmitSearch={() => { resetDetails(); if (mode === 'groups') void groups.replace(); else void topics.replace() }}
      onRefresh={() => { resetDetails(); if (mode === 'groups') void groups.replace(); else void topics.replace() }}
      busy={list.loading} disabled={!connection.live} error={list.error}
      empty={<p className="db-muted">{list.loading ? '正在读取…' : (mode === 'groups' ? '没有可见的消费组。' : '没有可见的 Topic。')}</p>}
      footer={list.nextCursor ? <button type="button" className="db-btn" disabled={list.loading} onClick={() => void list.append()}>{mode === 'groups' ? '加载更多消费组' : '加载更多 Topic'}</button> : undefined}>
      {mode === 'topics' ? topicNodes.map(node => <SearchTreeNode key={node.ref} text={node.title} selected={selected?.ref === node.ref} onSelect={() => void open(node)} />)
        : groupNodes.map(node => <SearchTreeNode key={node.ref} folder text={node.title} selected={selected?.ref === node.ref} onSelect={() => void open(node)} onOpen={() => void loadChildren(node)}>
          {(children[node.ref] || []).map(child => <SearchTreeNode key={child.ref} text={child.title} depth={1} selected={selected?.ref === child.ref} onSelect={() => void open(child)} />)}
          {childCursor[node.ref] && <button type="button" className="db-btn" disabled={childBusy[node.ref]} onClick={() => void loadChildren(node, true)}>加载更多关联 Topic</button>}
          {childBusy[node.ref] && <p className="db-muted">正在读取关联 Topic…</p>}
          {childError[node.ref] && <p className="db-error" role="alert">{childError[node.ref]}</p>}
        </SearchTreeNode>)}
    </SearchTree>}
    detail={<section className="db-kafka-overview-detail">
      {detailError && <p className="db-error" role="alert">{detailError}</p>}
      {(detail as { resultTruncated?: boolean } | undefined)?.resultTruncated && <p className="db-info-note">详情达到大小上限，仅显示部分信息。</p>}
      {(detail as { warning?: string } | undefined)?.warning && <p className="db-info-note">{(detail as { warning: string }).warning}</p>}
      {!selected && <p className="db-muted">{mode === 'groups' ? '选择消费组查看成员，或展开后查看某个 Topic 的消费进度。' : '选择 Topic 查看分区、Leader、水位和副本。'}</p>}
      {!selected && mode === 'topics' && connection.environment === 'sit' && <details><summary>创建 SIT 测试 Topic</summary>
        <div className="db-kafka-results"><label>名称<input value={createName} onChange={event => setCreateName(event.target.value)} /></label>
          <label>分区数<input type="number" min={1} max={32} value={createPartitions} onChange={event => setCreatePartitions(Number(event.target.value))} /></label>
          <label>复制因子<input type="number" min={1} max={3} value={createReplication} onChange={event => setCreateReplication(Number(event.target.value))} /></label>
          <label>清理策略<select value={createCleanup} onChange={event => setCreateCleanup(event.target.value as 'delete' | 'compact')}><option value="delete">delete</option><option value="compact">compact</option></select></label>
          <button type="button" className="db-btn" onClick={() => onUse(`CREATE_TOPIC ${JSON.stringify({ topic: createName, partitions: createPartitions, replicationFactor: createReplication, cleanupPolicy: createCleanup })}`)}>填入创建草稿</button></div>
      </details>}
      {selected?.kind === 'topic' && <>
        {detailBusy && !partitions.length
          ? <p className="db-muted">正在读取分区…</p>
          : <KafkaDescribeTable topic={topicName} partitions={partitions} onUse={onUse} heading={false} />}
        <p className="db-muted">消息读取使用临时消费组；不会提交业务消费位置。</p>
        <button type="button" className="db-btn" onClick={() => onUse(`TOPIC_CONFIG ${JSON.stringify(topicName)}`)}>查看 Topic 配置草稿</button>
        <button type="button" className="db-btn" onClick={() => onUse(`TIME_OFFSETS ${JSON.stringify({ topic: topicName, timestamp: Date.now() })}`)}>按时间定位草稿</button>
        <details><summary>跨分区有界扫描</summary><div className="db-kafka-results">
          <label>分区（逗号分隔，最多 8 个）<input value={scanPartitions} onChange={event => setScanPartitions(event.target.value)} /></label>
          <label>起始时间<input type="datetime-local" value={scanTime} onChange={event => setScanTime(event.target.value)} /></label>
          <label>Key 精确匹配（可空）<input value={scanKey} onChange={event => setScanKey(event.target.value)} /></label>
          <label>Header 名称（可空）<input value={scanHeaderName} onChange={event => setScanHeaderName(event.target.value)} /></label>
          {scanHeaderName && <label>Header 值<input value={scanHeaderValue} onChange={event => setScanHeaderValue(event.target.value)} /></label>}
          <button type="button" className="db-btn" onClick={() => {
            const partitions = scanPartitions.split(',').map(item => Number(item.trim()))
            onUse(`SCAN ${JSON.stringify({ topic: topicName, partitions, timestamp: Date.parse(scanTime),
              ...(scanKey ? { key: scanKey } : {}), ...(scanHeaderName ? { header: { name: scanHeaderName, value: scanHeaderValue } } : {}) })}`)
          }}>填入扫描草稿</button></div></details>
        {connection.environment === 'sit' && <button type="button" className="db-btn" onClick={() => onUse(`PRODUCE ${JSON.stringify({ topic: topicName, value: '' })}`)}>发布单条消息草稿</button>}
        {connection.environment === 'sit' && <details><summary>发布单条消息</summary><div className="db-kafka-results">
          <label>Key<input value={publishKey} onChange={event => setPublishKey(event.target.value)} /></label>
          <label>Value 格式<select value={publishEncoding} onChange={event => setPublishEncoding(event.target.value as 'utf8' | 'base64')}><option value="utf8">UTF-8</option><option value="base64">Base64 原始字节</option></select></label>
          <label>Value<textarea value={publishValue} onChange={event => setPublishValue(event.target.value)} /></label>
          <label>Headers JSON<textarea value={publishHeaders} onChange={event => setPublishHeaders(event.target.value)} /></label>
          <p className="db-muted">草稿会保存在共编文档中；单条解码后最多 64 KiB。</p>
          <button type="button" className="db-btn" onClick={() => {
            try { const headers = JSON.parse(publishHeaders); onUse(`PRODUCE ${JSON.stringify({ topic: topicName,
              ...(publishKey ? { key: publishKey } : {}), value: publishEncoding === 'base64' ? { base64: publishValue } : publishValue, headers })}`) }
            catch { setDetailError('Headers 必须是有效 JSON 对象。') }
          }}>填入发布草稿</button></div></details>}
        {connection.environment === 'sit' && <details><summary>限量批量发布</summary><div className="db-kafka-results">
          <label>消息数组 JSON（最多 10 条）<textarea value={batchMessages} onChange={event => setBatchMessages(event.target.value)} /></label>
          <button type="button" className="db-btn" onClick={() => { try { onUse(`PRODUCE_BATCH ${JSON.stringify({ topic: topicName, messages: JSON.parse(batchMessages) })}`) }
            catch { setDetailError('批量消息必须是有效 JSON 数组。') } }}>填入批量草稿</button></div></details>}
        {connection.environment === 'sit' && <details><summary>发布压缩墓碑</summary><div className="db-kafka-results">
          <p className="db-muted">仅 compact Topic；Broker 确认发布不代表历史消息已立即清理。</p>
          <label>Key<input value={tombstoneKey} onChange={event => setTombstoneKey(event.target.value)} /></label>
          <button type="button" className="db-btn" onClick={() => onUse(`TOMBSTONE ${JSON.stringify({ topic: topicName, key: tombstoneKey })}`)}>填入墓碑草稿</button>
        </div></details>}
      </>}
      {selected?.kind === 'group' && groupDetail && <KafkaGroupDetail group={groupDetail} heading={false} />}
      {selected?.kind === 'group-topic' && groupTopicDetail && <KafkaGroupTopicDetail detail={groupTopicDetail} heading={false} onUse={onUse} snapshotScope={`${connection.id}\0${connection.generation || ''}`} canWrite={connection.environment === 'sit'} />}
    </section>} />
}

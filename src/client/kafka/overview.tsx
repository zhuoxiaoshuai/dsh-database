import React, { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { Connection, WorkspaceBridge } from '../../shared/workbench.ts'
import type { ExplorerNode } from '../../shared/explorer.ts'
import { useDragResize } from '../workspace/parts/use-drag-resize.ts'
import { usePagedList } from '../workspace/parts/use-paged-list.ts'
import { SearchTree, SearchTreeNode, SearchTreeSplit } from '../workspace/tree/search-tree.tsx'
import { KafkaGroupDetail, KafkaGroupTopicDetail } from './group-detail.tsx'
import { KafkaDescribeTable } from './describe-table.tsx'
import type { KafkaPartitionRow } from './describe.ts'
import type { KafkaGroupResult, KafkaGroupTopicResult } from './results.tsx'

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

export function KafkaOverview({ bridge, connection, catalog = 'topics', refreshToken = 0, onUse }: {
  bridge: WorkspaceBridge
  connection: Connection
  catalog?: Mode
  refreshToken?: number
  onUse(text: string): void
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
  const [treeWidth, setTreeWidth] = useState(260)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const topicSearchRef = useRef('')
  const groupSearchRef = useRef('')
  const connectionRef = useRef(connection)
  const childLoading = useRef(new Set<string>())
  const detailToken = useRef(0)
  const detailAbort = useRef<AbortController | null>(null)
  topicSearchRef.current = topicSearch
  groupSearchRef.current = groupSearch
  connectionRef.current = connection
  const startResize = useDragResize((start, next) => setTreeWidth(Math.min(480, Math.max(180, treeWidth + (next.clientX - start.clientX)))))
  const loadTopics = async (cursor: string | undefined, signal: AbortSignal) => {
    if (!bridge.explorer) throw new Error('Kafka 对象读取通道不可用。')
    const page = await bridge.explorer(connection, 'list', { cursor, search: topicSearchRef.current }, signal)
    return { items: explorerItems(page), nextCursor: page.nextCursor }
  }
  const loadGroups = async (cursor: string | undefined, signal: AbortSignal) => {
    if (!bridge.explorer) throw new Error('Kafka 对象读取通道不可用。')
    const page = await bridge.explorer(connection, 'list', { parent: 'folder:groups', cursor, search: groupSearchRef.current }, signal)
    return { items: explorerItems(page), nextCursor: page.nextCursor }
  }
  const topics = usePagedList(loadTopics)
  const groups = usePagedList(loadGroups)
  const topicsReplace = topics.replace
  const groupsReplace = groups.replace
  const topicsReset = topics.reset
  const groupsReset = groups.reset

  useEffect(() => {
    setSelected(undefined)
    setDetail(undefined)
    setDetailError('')
    setChildren({})
    setChildError({})
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
    }
  }, [connection.id, connection.generation, connection.live, mode, refreshToken, topicsReplace, groupsReplace, topicsReset, groupsReset])

  const open = async (node: ExplorerNode) => {
    if (!bridge.explorer) return
    const current = ++detailToken.current
    detailAbort.current?.abort()
    const controller = new AbortController()
    detailAbort.current = controller
    setSelected(node)
    setDetail(undefined)
    setDrawerOpen(false)
    setDetailBusy(true)
    setDetailError('')
    try {
      const read = await bridge.explorer(connection, 'read', { ref: node.ref }, controller.signal) as TopicDetail | KafkaGroupResult | KafkaGroupTopicResult
      if (current === detailToken.current && !controller.signal.aborted) setDetail(read)
    } catch (caught) {
      if (current === detailToken.current && !controller.signal.aborted) setDetailError(caught instanceof Error ? caught.message : '详情读取失败。')
    } finally {
      if (current === detailToken.current) setDetailBusy(false)
    }
  }
  const loadChildren = async (node: ExplorerNode) => {
    if (!bridge.explorer || children[node.ref] || childLoading.current.has(node.ref)) return
    childLoading.current.add(node.ref)
    const current = connectionRef.current
    setChildError(previous => ({ ...previous, [node.ref]: '' }))
    try {
      const page = await bridge.explorer(current, 'list', { parent: node.ref })
      if (connectionRef.current.id !== current.id || connectionRef.current.generation !== current.generation) return
      setChildren(previous => previous[node.ref] ? previous : { ...previous, [node.ref]: page.nodes })
    } catch (caught) {
      if (connectionRef.current.id === current.id && connectionRef.current.generation === current.generation) {
        setChildError(previous => ({ ...previous, [node.ref]: caught instanceof Error ? caught.message : '关联 Topic 读取失败。' }))
      }
    } finally { childLoading.current.delete(node.ref) }
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
      onSubmitSearch={() => { if (mode === 'groups') { setChildren({}); void groups.replace() } else void topics.replace() }}
      onRefresh={() => { if (mode === 'groups') { setChildren({}); void groups.replace() } else void topics.replace() }}
      busy={list.loading} disabled={!connection.live} error={list.error}
      empty={<p className="db-muted">{list.loading ? '正在读取…' : (mode === 'groups' ? '没有可见的消费组。' : '没有可见的 Topic。')}</p>}
      footer={list.nextCursor ? <button type="button" className="db-btn" disabled={list.loading} onClick={() => void list.append()}>{mode === 'groups' ? '加载更多消费组' : '加载更多 Topic'}</button> : undefined}>
      {mode === 'topics' ? topicNodes.map(node => <SearchTreeNode key={node.ref} text={node.title} selected={selected?.ref === node.ref} onSelect={() => void open(node)} />)
        : groupNodes.map(node => <SearchTreeNode key={node.ref} folder text={node.title} selected={selected?.ref === node.ref} onSelect={() => void open(node)} onOpen={() => void loadChildren(node)}>
          {(children[node.ref] || []).map(child => <SearchTreeNode key={child.ref} text={child.title} depth={1} selected={selected?.ref === child.ref} onSelect={() => void open(child)} />)}
          {childError[node.ref] && <p className="db-error" role="alert">{childError[node.ref]}</p>}
        </SearchTreeNode>)}
    </SearchTree>}
    detail={<section className="db-kafka-overview-detail">
      {detailError && <p className="db-error" role="alert">{detailError}</p>}
      {!selected && <p className="db-muted">{mode === 'groups' ? '选择消费组查看成员，或展开后查看某个 Topic 的消费进度。' : '选择 Topic 查看分区、Leader、水位和副本。'}</p>}
      {selected?.kind === 'topic' && <>
        {detailBusy && !partitions.length
          ? <p className="db-muted">正在读取分区…</p>
          : <KafkaDescribeTable topic={topicName} partitions={partitions} onUse={onUse} heading={false} />}
        <p className="db-muted">消息读取使用临时消费组；不会提交业务消费位置。</p>
      </>}
      {selected?.kind === 'group' && groupDetail && <KafkaGroupDetail group={groupDetail} heading={false} />}
      {selected?.kind === 'group-topic' && groupTopicDetail && <KafkaGroupTopicDetail detail={groupTopicDetail} heading={false} />}
    </section>} />
}

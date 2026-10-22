import type { KnowledgeProvider, CommandKnowledgePort } from './knowledge-provider.ts'
import type { DataSourceId } from '../shared/data-sources/types.ts'
import { parseArchiveGuard, parseArchiveTargets } from './knowledge-archive-guard.ts'

export function createKnowledgeProvider(sourceId: DataSourceId, noun = '知识'): KnowledgeProvider<DataSourceId, CommandKnowledgePort> {return {
  id: sourceId,
  dispatch(store, connectionId, body) {
    const action = body.action
    if (sourceId === 'redis' && typeof action === 'string' && action.startsWith('template-')) throw new Error('请提供当前 SQL 连接。')
    if (action === 'knowledge-search') return { items: store.searchKnowledge(sourceId, connectionId, String(body.query || '')) }
    if (action === 'knowledge-get') {
      const item = store.getKnowledge(sourceId, String(body.id || ''), connectionId)
      if (!item) throw new Error(`${noun}条目不存在。`)
      return item
    }
    if (action === 'knowledge-preview') return store.previewKnowledge(sourceId, String(body.text || ''))
    if (action === 'knowledge-publish') return store.publishKnowledge({ sourceId: sourceId, connectionId, text: String(body.text || ''),
      title: typeof body.title === 'string' ? body.title : undefined, summary: typeof body.summary === 'string' ? body.summary : undefined,
      tags: Array.isArray(body.tags) ? body.tags as string[] : undefined,
      id: typeof body.id === 'string' ? body.id : undefined,
      expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined })
    if (action === 'knowledge-archive') return store.archiveKnowledge(sourceId, String(body.id || ''), connectionId, parseArchiveGuard(body.archiveGuard))
    if (action === 'knowledge-cluster') return { groups: store.clusterKnowledge(sourceId, connectionId) }
    if (action === 'knowledge-tidy-get') return { tidy: store.getTidy(connectionId) ?? null }
    if (action === 'knowledge-tidy-apply' || action === 'knowledge-tidy-reject') {
      const ids = Array.isArray(body.ids) ? body.ids.filter((item): item is string => typeof item === 'string') : undefined
      const batchId = typeof body.batchId === 'string' ? body.batchId : ''
      if (action === 'knowledge-tidy-reject') return store.rejectTidy(connectionId, batchId, ids)
      return store.applyTidy(connectionId, batchId, ids)
    }
    if (action === 'knowledge-archive-duplicates') {
      if (typeof body.keepId !== 'string' || !body.keepId.trim()) throw new Error('请提供 keepId。')
      if (!Array.isArray(body.ids) || body.ids.length === 0) throw new Error('请提供归档列表。')
      const ids = body.ids.map(item => {
        if (typeof item !== 'string' || !item.trim()) throw new Error('归档列表无效。')
        return item.trim()
      })
      parseArchiveTargets(body.guards, [body.keepId.trim(), ...ids])
      return store.archiveKnowledgeDuplicates(sourceId, connectionId, body.keepId.trim(), ids, body.guards)
    }
    throw new Error('不支持此知识操作。')
  },
}}

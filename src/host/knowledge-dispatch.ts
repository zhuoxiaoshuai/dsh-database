import type { KnowledgeProvider } from './knowledge-provider.ts'
import type { DataSourceId } from '../shared/data-sources/types.ts'

export function createKnowledgeProvider(sourceId: DataSourceId, noun = '知识'): KnowledgeProvider {return {
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
    if (action === 'knowledge-archive') return store.archiveKnowledge(sourceId, String(body.id || ''), connectionId)
    throw new Error('不支持此知识操作。')
  },
}}

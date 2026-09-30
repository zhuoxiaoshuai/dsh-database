import type { KnowledgeProvider } from '../../knowledge-provider.ts'

export const redisKnowledge: KnowledgeProvider = {
  id: 'redis',
  dispatch(store, connectionId, body) {
    const action = body.action
    if (typeof action === 'string' && action.startsWith('template-')) throw new Error('请提供当前 SQL 连接。')
    if (action === 'knowledge-search') return { items: store.searchKnowledge('redis', connectionId, String(body.query || '')) }
    if (action === 'knowledge-get') {
      const item = store.getKnowledge('redis', String(body.id || ''), connectionId)
      if (!item) throw new Error('知识条目不存在。')
      return item
    }
    if (action === 'knowledge-preview') return store.previewKnowledge('redis', String(body.text || ''))
    if (action === 'knowledge-publish') return store.publishKnowledge({ sourceId: 'redis', connectionId, text: String(body.text || ''),
      title: typeof body.title === 'string' ? body.title : undefined, summary: typeof body.summary === 'string' ? body.summary : undefined,
      tags: Array.isArray(body.tags) ? body.tags as string[] : undefined,
      id: typeof body.id === 'string' ? body.id : undefined,
      expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined })
    if (action === 'knowledge-archive') return store.archiveKnowledge('redis', String(body.id || ''), connectionId)
    throw new Error('不支持此知识操作。')
  },
}

import type { KnowledgeProvider } from '../../knowledge-provider.ts'

export const kafkaKnowledge: KnowledgeProvider<'kafka'> = {
  id: 'kafka',
  dispatch(store, connectionId, body) {
    const action = body.action
    if (action === 'knowledge-search') return { items: store.searchKnowledge('kafka', connectionId, String(body.query || '')) }
    if (action === 'knowledge-get') {
      const item = store.getKnowledge('kafka', String(body.id || ''), connectionId)
      if (!item) throw new Error('经验条目不存在。')
      return item
    }
    if (action === 'knowledge-preview') return store.previewKnowledge('kafka', String(body.text || ''))
    if (action === 'knowledge-publish') return store.publishKnowledge({ sourceId: 'kafka', connectionId, text: String(body.text || ''),
      title: typeof body.title === 'string' ? body.title : undefined, summary: typeof body.summary === 'string' ? body.summary : undefined,
      tags: Array.isArray(body.tags) ? body.tags as string[] : undefined,
      id: typeof body.id === 'string' ? body.id : undefined,
      expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined })
    if (action === 'knowledge-archive') return store.archiveKnowledge('kafka', String(body.id || ''), connectionId)
    throw new Error('不支持此经验操作。')
  },
}

import type { SqlDataSourceId } from '../../shared/data-sources/types.ts'
import type { KnowledgeProvider } from '../knowledge-provider.ts'

export function sqlKnowledgeProvider(id: SqlDataSourceId): KnowledgeProvider {
  return {
    id,
    dispatch(store, connectionId, body) {
      if (typeof body.action === 'string' && body.action.startsWith('knowledge-')) throw new Error('请提供当前 Redis 连接。')
      if (typeof body.action !== 'string' || !body.action.startsWith('template-')) throw new Error('不支持此模板操作。')
      if (body.dialect !== undefined && body.dialect !== id) throw new Error('数据源与连接不匹配。')
      if (body.action === 'template-get' || body.action === 'template-archive') {
        const item = store.get(String(body.id || ''))
        if (!item || item.connectionId !== connectionId) throw new Error('模板不属于此连接。')
      }
      return store.dispatch({ ...body, connectionId, dialect: id })
    },
  }
}

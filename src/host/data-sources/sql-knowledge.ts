import type { SqlDataSourceId } from '../../shared/data-sources/types.ts'
import type { KnowledgeProvider, SqlKnowledgePort } from '../knowledge-provider.ts'
import { parseArchiveGuard, parseArchiveTargets } from '../knowledge-archive-guard.ts'

export function sqlKnowledgeProvider(id: SqlDataSourceId): KnowledgeProvider<SqlDataSourceId, SqlKnowledgePort> {
  return {
    id,
    dispatch(store, connectionId, body) {
      if (typeof body.action === 'string' && body.action.startsWith('knowledge-')) throw new Error('请提供当前 Redis 连接。')
      if (typeof body.action !== 'string' || !body.action.startsWith('template-')) throw new Error('不支持此模板操作。')
      if (body.dialect !== undefined && body.dialect !== id) throw new Error('数据源与连接不匹配。')
      if (body.action === 'template-publish' && ['newVersion', 'variant', 'mergeMeta', 'useExisting'].includes(String(body.publishAction))) {
        const item = store.get(String(body.targetId || ''))
        if (!item || item.connectionId !== connectionId) throw new Error('模板不属于此连接。')
        if (item.dialect !== id) throw new Error('数据源与目标模板不匹配。')
      }
      if (body.action === 'template-get' || body.action === 'template-archive' || body.action === 'template-annotate') {
        const item = store.get(String(body.id || ''))
        if (!item || item.connectionId !== connectionId) throw new Error('模板不属于此连接。')
      }
      if (body.action === 'template-archive-duplicates') {
        parseArchiveTargets(body.guards, [String(body.keepId || ''), ...(Array.isArray(body.ids) ? body.ids as string[] : [])])
        const item = store.get(String(body.keepId || ''))
        if (!item || item.connectionId !== connectionId) throw new Error('模板不属于此连接。')
      }
      if (body.action === 'template-archive') parseArchiveGuard(body.archiveGuard)
      return store.dispatch({ ...body, connectionId, dialect: id })
    },
  }
}

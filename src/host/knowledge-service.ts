import type { DataSourceId } from '../shared/data-sources/types.ts'
import type { KnowledgeStorePort } from './knowledge-provider.ts'
import { hostModules } from './data-sources/modules.ts'

export class KnowledgeService {
  private readonly store: KnowledgeStorePort
  constructor(store: KnowledgeStorePort) { this.store = store }
  dispatch(sourceId: DataSourceId, connectionId: string, body: Record<string, unknown>): Promise<unknown> | unknown {
    if (!connectionId) throw new Error('请提供 connectionId。')
    const provider = hostModules.get(sourceId).knowledge
    if (!provider) throw new Error('此数据源不支持此能力。')
    return provider.dispatch(this.store, connectionId, body)
  }
}

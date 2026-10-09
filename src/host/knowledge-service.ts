import type { DataSourceId } from '../shared/data-sources/types.ts'
import type { SqlTemplateStore } from './sql-template-store.ts'
import { hostModules } from './data-sources/modules.ts'

export class KnowledgeService {
  private readonly store: SqlTemplateStore
  constructor(store: SqlTemplateStore) { this.store = store }
  dispatch(sourceId: DataSourceId, connectionId: string, body: Record<string, unknown>): Promise<unknown> | unknown {
    if (!connectionId) throw new Error('请提供 connectionId。')
    return hostModules.get(sourceId).knowledge.dispatch(this.store, connectionId, body)
  }
}

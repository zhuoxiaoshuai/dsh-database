import type { DataSourceId } from '../shared/data-sources/types.ts'
import type { SqlTemplateStore } from './sql-template-store.ts'
import type { KnowledgeProvider } from './knowledge-provider.ts'
import { hostModules } from './data-sources/modules.ts'
import { supportedAllDataSources } from '../shared/data-sources/registry.ts'

export function createKnowledgeRegistry<Id extends string>(providers: readonly KnowledgeProvider<Id>[], expectedIds: readonly Id[]) {
  const expected = new Set(expectedIds)
  const byId = new Map<Id, KnowledgeProvider<Id>>()
  if (expected.size !== expectedIds.length) throw new Error('知识能力声明重复。')
  for (const provider of providers) {
    if (!provider || !expected.has(provider.id) || byId.has(provider.id) || typeof provider.dispatch !== 'function') throw new Error(`知识能力无效或重复：${String(provider?.id)}`)
    byId.set(provider.id, provider)
  }
  for (const id of expected) if (!byId.has(id)) throw new Error(`缺少数据源知识能力：${id}`)
  return Object.freeze({
    ids: () => [...byId.keys()],
    get(id: Id) {
      const provider = byId.get(id)
      if (!provider) throw new Error(`不支持此数据源：${String(id)}`)
      return provider
    },
  })
}

const providers = createKnowledgeRegistry(hostModules.ids().map(id => hostModules.get(id).knowledge), supportedAllDataSources)

export class KnowledgeService {
  private readonly store: SqlTemplateStore
  constructor(store: SqlTemplateStore) { this.store = store }
  dispatch(sourceId: DataSourceId, connectionId: string, body: Record<string, unknown>): Promise<unknown> | unknown {
    if (!connectionId) throw new Error('请提供 connectionId。')
    return providers.get(sourceId).dispatch(this.store, connectionId, body)
  }
}

import type { ExplorerProvider } from '../../src/host/explorer-provider.ts'
import type { KnowledgeProvider } from '../../src/host/knowledge-provider.ts'
export function createExplorerRegistry<Id extends string>(providers: readonly ExplorerProvider<Id>[], expectedIds: readonly Id[]) {
  const expected = new Set(expectedIds)
  const byId = new Map<Id, ExplorerProvider<Id>>()
  if (expected.size !== expectedIds.length) throw new Error('对象浏览能力声明重复。')
  for (const provider of providers) {
    if (!provider || !expected.has(provider.id) || byId.has(provider.id) || typeof provider.list !== 'function' || typeof provider.read !== 'function') throw new Error(`对象浏览能力无效或重复：${String(provider?.id)}`)
    byId.set(provider.id, provider)
  }
  for (const id of expected) if (!byId.has(id)) throw new Error(`缺少数据源对象浏览能力：${id}`)
  return Object.freeze({
    ids: () => [...byId.keys()],
    get(id: Id) {
      const provider = byId.get(id)
      if (!provider) throw new Error(`不支持此数据源：${String(id)}`)
      return provider
    },
  })
}


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

export type WorkspaceRegistration<Id extends string, Context, View> = {
  id: Id
  render(context: Context): View
}

export function createWorkspaceRegistry<Id extends string, Context, View>(
  entries: readonly WorkspaceRegistration<Id, Context, View>[],
  expectedIds: readonly Id[],
) {
  const expected = new Set(expectedIds)
  const byId = new Map<Id, WorkspaceRegistration<Id, Context, View>>()
  if (expected.size !== expectedIds.length) throw new Error('数据源工作台声明重复。')
  for (const entry of entries) {
    if (!entry || !expected.has(entry.id) || byId.has(entry.id) || typeof entry.render !== 'function') {
      throw new Error(`无效或重复的数据源工作台：${String(entry?.id)}`)
    }
    byId.set(entry.id, entry)
  }
  for (const id of expected) if (!byId.has(id)) throw new Error(`缺少数据源工作台：${id}`)
  return Object.freeze({
    ids: () => [...byId.keys()],
    get(id: Id) {
      const source = byId.get(id)
      if (!source) throw new Error(`不支持此数据源：${String(id)}`)
      return source
    },
  })
}

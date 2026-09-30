export function createConnectionFormRegistry<Id extends string, Source extends { id: Id; createInput: Function; showCredentials: Function; fields: Function }>(sources: readonly Source[], expectedIds: readonly Id[]) {
  const expected = new Set(expectedIds)
  const byId = new Map<Id, Source>()
  if (expected.size !== expectedIds.length) throw new Error('连接表单数据源声明重复。')
  for (const source of sources) {
    if (!source || !expected.has(source.id) || byId.has(source.id) || typeof source.createInput !== 'function' || typeof source.showCredentials !== 'function' || typeof source.fields !== 'function') throw new Error(`连接表单数据源无效或重复：${String(source?.id)}`)
    byId.set(source.id, source)
  }
  for (const id of expected) if (!byId.has(id)) throw new Error(`缺少连接表单数据源：${id}`)
  return Object.freeze({ ids: () => [...byId.keys()], get(id: Id): Source {
    const source = byId.get(id)
    if (!source) throw new Error(`不支持此数据源：${String(id)}`)
    return source
  } })
}

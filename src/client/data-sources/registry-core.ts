import type { DataSourceId } from '../../shared/data-sources/types.ts'
import type { ClientSourceModule } from './types.ts'

export function createClientModuleRegistry(entries: readonly ClientSourceModule[], expected: readonly DataSourceId[]) {
  const ids = new Set(expected)
  const byId = new Map<DataSourceId, ClientSourceModule>()
  if (ids.size !== expected.length) throw new Error('数据源模块声明重复。')
  for (const module of entries) {
    if (!module || !ids.has(module.id) || byId.has(module.id) || module.descriptor?.id !== module.id
      || module.connection?.id !== module.id || !module.workspace
      || module.history?.id !== module.id || typeof module.history?.renderText !== 'function'
      || typeof module.history?.resultEnvelope !== 'function' || typeof module.history?.renderResult !== 'function'
      || module.workspace.mode !== 'standard' || typeof module.workspace.useBindings !== 'function') {
      throw new Error(`数据源客户端模块不完整或重复：${String(module?.id)}`)
    }
    byId.set(module.id, module)
  }
  for (const id of ids) if (!byId.has(id)) throw new Error(`缺少客户端模块：${id}`)
  return Object.freeze({ ids: () => [...byId.keys()], get(id: DataSourceId) {
    const module = byId.get(id)
    if (!module) throw new Error(`不支持此数据源：${id}`)
    return module
  } })
}

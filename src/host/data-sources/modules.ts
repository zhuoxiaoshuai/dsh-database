import { supportedAllDataSources } from '../../shared/data-sources/registry.ts'
import type { DataSourceId } from '../../shared/data-sources/types.ts'
import { mysqlModule } from './mysql/module.ts'
import { oracleModule } from './oracle/module.ts'
import { redisModule } from './redis/module.ts'
import { kafkaModule } from './kafka/module.ts'
import type { HostSourceModule } from './module-types.ts'

export function createHostModuleRegistry(entries: readonly HostSourceModule[], expected: readonly DataSourceId[]) {
  const ids = new Set(expected)
  const byId = new Map<DataSourceId, HostSourceModule>()
  if (ids.size !== expected.length) throw new Error('Host 数据源模块声明重复。')
  for (const module of entries) {
    if (!module || !ids.has(module.id) || byId.has(module.id) || module.runtime?.id !== module.id
      || typeof module.connection?.validate !== 'function' || typeof module.connection?.fingerprint !== 'function'
      || typeof module.connection?.normalizeStoredSettings !== 'function'
      || !module.ai?.key || typeof module.ai?.register !== 'function'
      || typeof module.explorer?.list !== 'function' || typeof module.explorer?.read !== 'function'
      || typeof module.knowledge?.dispatch !== 'function'
      || !module.execution || (module.execution.mode === 'standard-text' ? typeof module.execution.prepareText !== 'function' || typeof module.execution.normalizeContext !== 'function' || typeof module.execution.authorize !== 'function'
        : module.execution.mode === 'legacy-adapter' ? !['mysql', 'oracle', 'redis'].includes(module.id) : true)) throw new Error(`Host 数据源模块不完整或重复：${String(module?.id)}`)
    byId.set(module.id, module)
  }
  for (const id of ids) if (!byId.has(id)) throw new Error(`缺少 Host 数据源模块：${id}`)
  return Object.freeze({ ids: () => [...byId.keys()], get(id: DataSourceId) {
    const module = byId.get(id)
    if (!module) throw new Error(`不支持此数据源：${id}`)
    return module
  } })
}

export const hostModules = createHostModuleRegistry([mysqlModule, oracleModule, redisModule, kafkaModule], supportedAllDataSources)

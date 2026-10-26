import { supportedAllDataSources } from '../../shared/data-sources/registry.ts'
import type { DataSourceId } from '../../shared/data-sources/types.ts'
import { mysqlModule } from './mysql/module.ts'
import { oracleModule } from './oracle/module.ts'
import { redisModule } from './redis/module.ts'
import { kafkaModule } from './kafka/module.ts'
import { nacosModule } from './nacos/module.ts'
import { isValidSourceRuntime } from './runtime-contract.mjs'
import type { HostSourceModule } from './module-types.ts'

export function createHostModuleRegistry(entries: readonly HostSourceModule[], expected: readonly DataSourceId[]) {
  const ids = new Set(expected)
  const byId = new Map<DataSourceId, HostSourceModule>()
  if (ids.size !== expected.length) throw new Error('Host 数据源模块声明重复。')
  for (const module of entries) {
    if (!module || !ids.has(module.id) || byId.has(module.id) || module.runtime?.id !== module.id
      || typeof module.connection?.validate !== 'function' || typeof module.connection?.fingerprint !== 'function'
      || typeof module.connection?.normalizeStoredSettings !== 'function'
      || (module.execution !== undefined && !['sql','command'].includes(module.runtime.documentKind || ''))
      || (module.ai !== undefined && (!module.ai.key || typeof module.ai.register !== 'function'))
      || (module.explorer !== undefined && (typeof module.explorer.list !== 'function' || typeof module.explorer.read !== 'function'))
      || (module.knowledge !== undefined && typeof module.knowledge.dispatch !== 'function')
      || (module.execution !== undefined && (module.execution.mode !== 'standard-text' || typeof module.execution.prepareText !== 'function'
      || typeof module.execution.normalizeContext !== 'function' || typeof module.execution.authorize !== 'function'))) throw new Error(`Host 数据源模块不完整或重复：${String(module?.id)}`)
    byId.set(module.id, module)
  }
  for (const id of ids) if (!byId.has(id)) throw new Error(`缺少 Host 数据源模块：${id}`)
  return Object.freeze({ ids: () => [...byId.keys()], get(id: DataSourceId) {
    const module = byId.get(id)
    if (!module) throw new Error(`不支持此数据源：${id}`)
    return module
  } })
}

export const hostModules = createHostModuleRegistry([mysqlModule, oracleModule, redisModule, kafkaModule, nacosModule], supportedAllDataSources)

export type HostSourceRuntime = HostSourceModule['runtime']

export function createRuntimeRegistry(entries: readonly HostSourceRuntime[]) {
  const byId = new Map<DataSourceId, HostSourceRuntime>()
  for (const entry of entries) {
    // runtime 形状规则单源于 runtime-contract.mjs（与 provider-registry.mjs 共用）。
    if (!entry || byId.has(entry.id) || !isValidSourceRuntime(entry)) {
      throw new Error(`数据源运行能力不完整或重复：${String(entry?.id)}`)
    }
    byId.set(entry.id, entry)
  }
  return Object.freeze({
    ids: () => [...byId.keys()],
    get(id: DataSourceId) {
      const runtime = byId.get(id)
      if (!runtime) throw new Error(`不支持此数据源：${String(id)}`)
      return runtime
    },
  })
}

const runtimes = createRuntimeRegistry(hostModules.ids().map(id => hostModules.get(id).runtime))
export const getSourceRuntime = (id: DataSourceId) => runtimes.get(id)
export const registeredSourceRuntimes = () => runtimes.ids()

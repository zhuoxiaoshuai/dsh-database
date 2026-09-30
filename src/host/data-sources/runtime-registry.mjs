import { mysqlRuntime } from './mysql/runtime.mjs'
import { oracleRuntime } from './oracle/runtime.mjs'
import { redisRuntime } from './redis/runtime.mjs'
import { kafkaRuntime } from './kafka/runtime.mjs'

export function createRuntimeRegistry(entries) {
  const byId = new Map()
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || byId.has(entry.id)
      || typeof entry.workerEntry !== 'string' || !/^[a-z][a-z0-9-]*-worker\.mjs$/.test(entry.workerEntry)
      || typeof entry.requiresPassword !== 'boolean' || typeof entry.usesCustomCa !== 'function'
      || !Array.isArray(entry.actions) || !entry.actions.length || entry.actions.some(action => typeof action !== 'string' || !action)
      || new Set(entry.actions).size !== entry.actions.length || !['sql', 'command'].includes(entry.documentKind)) {
      throw new Error(`数据源运行能力不完整或重复：${String(entry?.id)}`)
    }
    byId.set(entry.id, entry)
  }
  return Object.freeze({
    ids: () => [...byId.keys()],
    get(id) {
      const runtime = byId.get(id)
      if (!runtime) throw new Error(`不支持此数据源：${String(id)}`)
      return runtime
    },
  })
}

const runtimes = createRuntimeRegistry([mysqlRuntime, oracleRuntime, redisRuntime, kafkaRuntime])
export const getSourceRuntime = id => runtimes.get(id)
export const registeredSourceRuntimes = () => runtimes.ids()

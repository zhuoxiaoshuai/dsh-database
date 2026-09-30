import { mysqlProvider } from './mysql/index.mjs'
import { oracleProvider } from './oracle/index.mjs'
import { redisProvider } from './redis/index.mjs'

const requiredDriverMethods = [
  'openCatalog', 'openQuery', 'openMaintenance', 'destroy', 'cancel', 'probe',
  'prepareReadonly', 'reset', 'runSelect', 'prepareWrite', 'executeWrite',
]

export function createDataSourceRegistry(providers) {
  const registered = new Map()
  for (const provider of providers) {
    if (!provider || typeof provider.id !== 'string' || !provider.id || !['sql', 'redis'].includes(provider.family) || registered.has(provider.id)) throw new Error('数据源注册信息无效或重复。')
    if (!provider.runtime || provider.runtime.id !== provider.id || typeof provider.runtime.workerEntry !== 'string' || !/^[a-z][a-z0-9-]*-worker\.mjs$/.test(provider.runtime.workerEntry) || typeof provider.runtime.requiresPassword !== 'boolean' || typeof provider.runtime.usesCustomCa !== 'function' || !Array.isArray(provider.runtime.actions) || !provider.runtime.actions.length || !['sql', 'command'].includes(provider.runtime.documentKind)) throw new Error(`数据源运行能力不完整：${provider.id}`)
    if (provider.family === 'redis') {
      if (!provider.connection || ['validateTarget', 'fingerprintSuffix'].some(method => typeof provider.connection[method] !== 'function')) throw new Error(`数据源连接能力不完整：${provider.id}`)
      if (!provider.driver || ['open', 'probe', 'databases', 'close', 'execute', 'scan', 'suggestKeys', 'key', 'revive'].some(method => typeof provider.driver[method] !== 'function')) throw new Error(`Redis 驱动能力不完整：${provider.id}`)
      if (!provider.capabilities || provider.capabilities.command !== true || provider.capabilities.scan !== true || provider.capabilities.key !== true) throw new Error(`Redis 能力声明不完整：${provider.id}`)
      if (!provider.recovery || provider.recovery.replayCommands !== false || provider.recovery.uncertainOnInterruption !== true) throw new Error(`Redis 恢复规则不完整：${provider.id}`)
      registered.set(provider.id, provider)
      continue
    }
    if (!provider.connection || ['config', 'validateTarget', 'fingerprintSuffix'].some(method => typeof provider.connection[method] !== 'function')) throw new Error(`数据源连接能力不完整：${provider.id}`)
    if (!provider.driver || provider.driver.id !== provider.id || requiredDriverMethods.some(method => typeof provider.driver[method] !== 'function')) throw new Error(`数据源驱动能力不完整：${provider.id}`)
    if (!provider.capabilities || typeof provider.capabilities.showStatement !== 'boolean' || typeof provider.capabilities.showIndex !== 'boolean' || (provider.capabilities.showStatement && typeof provider.driver.executeShow !== 'function')) throw new Error(`数据源能力声明不完整：${provider.id}`)
    if (!provider.catalog || typeof provider.catalog.statement !== 'function' || typeof provider.catalog.read !== 'function') throw new Error(`数据源目录能力不完整：${provider.id}`)
    if (!provider.policy || typeof provider.policy.authorize !== 'function' || typeof provider.policy.extractExplainSql !== 'function' || typeof provider.policy.splitStatements !== 'function' || typeof provider.policy.validateMaintenanceSelect !== 'function') throw new Error(`数据源 SQL 策略能力不完整：${provider.id}`)
    if (!provider.maintenance || ['inspect', 'privileges', 'dependencies', 'sqlMode', 'verifyIdentity', 'prepareDml', 'executeDml', 'commit', 'rollback', 'prepareDdl', 'readDdl', 'executeDdl', 'peekDdl', 'isUncertainDdlError', 'open', 'close'].some(method => typeof provider.maintenance[method] !== 'function')) throw new Error(`数据源维护能力不完整：${provider.id}`)
    if (!provider.recovery || ['discardOnTimeout', 'isFatalCatalog', 'isFatalQuery', 'shouldRetryReadonly'].some(method => typeof provider.recovery[method] !== 'function')) throw new Error(`数据源恢复能力不完整：${provider.id}`)
    registered.set(provider.id, provider)
  }
  return Object.freeze({
    ids: () => [...registered.keys()],
    get(id) {
      const provider = registered.get(id)
      if (!provider) throw new Error(`不支持此数据库方言：${String(id || '')}`)
      return provider
    },
  })
}

const registry = createDataSourceRegistry([mysqlProvider, oracleProvider, redisProvider])
export const getDataSource = id => getSqlDataSource(id)
export const getSqlDataSource = id => {
  const provider = registry.get(id)
  if (provider.family !== 'sql') throw new Error(`不是 SQL 数据源：${String(id || '')}`)
  return provider
}
export const getRedisDataSource = id => {
  const provider = registry.get(id)
  if (provider.family !== 'redis') throw new Error(`不是 Redis 数据源：${String(id || '')}`)
  return provider
}
export const registeredDataSources = () => registry.ids().filter(id => registry.get(id).family === 'sql')
export const registeredAllDataSources = () => registry.ids()

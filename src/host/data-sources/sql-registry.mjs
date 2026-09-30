import { mysqlProvider } from './mysql/index.mjs'
import { oracleProvider } from './oracle/index.mjs'

const providers = new Map([['mysql', mysqlProvider], ['oracle', oracleProvider]])
export function getSqlDataSource(id) {
  const provider = providers.get(id)
  if (!provider) throw new Error(`不支持此数据库方言：${String(id || '')}`)
  return provider
}
export const getDataSource = getSqlDataSource
export const registeredDataSources = () => [...providers.keys()]

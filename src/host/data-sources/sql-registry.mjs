import {createDataSourceRegistry} from './provider-registry.mjs'
import { mysqlProvider } from './mysql/index.mjs'
import { oracleProvider } from './oracle/index.mjs'

const providers = createDataSourceRegistry([mysqlProvider, oracleProvider])
export function getSqlDataSource(id) {
  if (id === 'redis' || id === 'kafka' || id === 'nacos') throw new Error(`不是 SQL 数据源：${id}`)
  const provider = providers.get(id)
  if (!provider) throw new Error(`不支持此数据库方言：${String(id || '')}`)
  return provider
}
export const getDataSource = getSqlDataSource
export const registeredDataSources = () => [...providers.ids()]

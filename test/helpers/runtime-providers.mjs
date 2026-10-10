export {createDataSourceRegistry} from '../../src/host/data-sources/provider-registry.mjs'
export {getSqlDataSource as getDataSource, registeredDataSources} from '../../src/host/data-sources/sql-registry.mjs'
export {getRedisDataSource} from '../../src/host/data-sources/redis-registry.mjs'
import {registeredDataSources} from '../../src/host/data-sources/sql-registry.mjs'
export const registeredAllDataSources = () => [...registeredDataSources(), 'redis']

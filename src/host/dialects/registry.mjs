import { getDataSource, registeredDataSources } from '../data-sources/sql-registry.mjs'

export function getDialect(id) {
  return getDataSource(id).driver
}

export function getSqlDialect(id) {
  return getDialect(id).sql
}

export function registeredDialects() {
  return registeredDataSources()
}

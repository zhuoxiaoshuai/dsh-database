import { getDataSource } from './data-sources/sql-registry.mjs'
export { normalizeIndexes, normalizeConstraints, visibleCatalogSql } from './data-sources/catalog-common.mjs'

export function catalogStatement(dialect, input) {
  return getDataSource(dialect).catalog.statement(input)
}

export async function catalog(connection, dialect, input, signal) {
  return getDataSource(dialect).catalog.read(connection, input, signal)
}

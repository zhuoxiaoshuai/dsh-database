import type { Dialect } from './workbench.ts'
import { clientWorkspaceDescriptor, supportedDataSources } from './data-sources/registry.ts'
import type { SqlClientDescriptor } from './data-sources/types.ts'

export type DialectCapabilities = SqlClientDescriptor
export const supportedDialects = Object.freeze([...supportedDataSources] as Dialect[])
export function dialectCapabilities(dialect: Dialect): DialectCapabilities {
  const source = clientWorkspaceDescriptor(dialect)
  if (source.family !== 'sql') throw new Error('此数据源不使用 SQL 方言能力。')
  return source
}

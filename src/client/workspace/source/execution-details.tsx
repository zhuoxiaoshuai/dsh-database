import type { DataSourceId } from '../../../shared/data-sources/types.ts'
import { supportedAllDataSources } from '../../../shared/data-sources/registry.ts'
import { clientModules } from '../../data-sources/registry.ts'
export function executionDetailSource(id?: string) {
  if (!id || !supportedAllDataSources.includes(id as DataSourceId)) return undefined
  return clientModules.get(id as DataSourceId).history
}

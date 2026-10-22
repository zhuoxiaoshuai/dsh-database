import type { DataSourceId } from '../../../shared/data-sources/types.ts'
import { supportedAllDataSources } from '../../../shared/data-sources/registry.ts'
import { historySources } from '../../data-sources/history-registry.ts'
export function executionDetailSource(id?: string) {
  if (!id || !supportedAllDataSources.includes(id as DataSourceId)) return undefined
  return historySources.get(id as DataSourceId)
}

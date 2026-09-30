import type { DataSourceId } from '../shared/data-sources/types.ts'
import type { CatalogRequest, CatalogResult } from '../shared/workbench.ts'
import type { ExplorerListInput, ExplorerPage, ExplorerReadInput } from '../shared/explorer.ts'

export type ExplorerTransport = {
  catalog(input: CatalogRequest, signal?: AbortSignal): Promise<CatalogResult>
  redis(action: 'redis-scan' | 'redis-key', input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>
  source?(action: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>
}

export type ExplorerProvider<Id extends string = DataSourceId> = {
  id: Id
  readonlyActions?: readonly string[]
  list(transport: ExplorerTransport, input: ExplorerListInput, signal?: AbortSignal): Promise<ExplorerPage>
  read(transport: ExplorerTransport, input: ExplorerReadInput, signal?: AbortSignal): Promise<unknown>
}

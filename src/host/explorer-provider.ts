import type { DataSourceId } from '../shared/data-sources/types.ts'
import type { CatalogRequest, CatalogResult } from '../shared/workbench.ts'
import type { ExplorerListInput, ExplorerPage, ExplorerReadInput } from '../shared/explorer.ts'

export type ExplorerTransport = {
  request(action: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, any>>
}
/** Legacy local adapters remain accepted at the service boundary, not required by Providers. */
export type LegacyExplorerTransport = {
  catalog?(input: CatalogRequest, signal?: AbortSignal): Promise<CatalogResult>
  redis?(action: 'redis-scan' | 'redis-key', input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>
  source?(action: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>
}
export function explorerTransport(transport: ExplorerTransport | LegacyExplorerTransport): ExplorerTransport {
  if ('request' in transport) return transport
  return { request: async (action, input, signal) => {
    if (action === 'catalog' && transport.catalog) return transport.catalog(input as unknown as CatalogRequest, signal)
    if ((action === 'redis-scan' || action === 'redis-key') && transport.redis) return transport.redis(action, input, signal)
    if (transport.source) return transport.source(action, input, signal)
    throw new Error('对象读取通道不可用。')
  } }
}

export type ExplorerProvider<Id extends string = DataSourceId> = {
  id: Id
  readonlyActions?: readonly string[]
  list(transport: ExplorerTransport, input: ExplorerListInput, signal?: AbortSignal): Promise<ExplorerPage>
  read(transport: ExplorerTransport, input: ExplorerReadInput, signal?: AbortSignal): Promise<unknown>
}

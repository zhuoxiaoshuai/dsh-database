import type { DataSourceId } from '../shared/data-sources/types.ts'
import type { ExplorerListInput, ExplorerReadInput } from '../shared/explorer.ts'
import type { ExplorerTransport } from './explorer-provider.ts'
import { hostModules } from './data-sources/modules.ts'

export class ExplorerService {
  list(sourceId: DataSourceId, transport: ExplorerTransport, input: ExplorerListInput, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('读取已取消。')
    if (!input || typeof input !== 'object' || (input.parent !== undefined && (typeof input.parent !== 'string' || input.parent.length > 8192))
      || (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 128))
      || (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 256))) throw new Error('对象浏览请求无效。')
    return hostModules.get(sourceId).explorer.list(transport, input, signal)
  }
  read(sourceId: DataSourceId, transport: ExplorerTransport, input: ExplorerReadInput, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('读取已取消。')
    if (!input || typeof input !== 'object' || typeof input.ref !== 'string' || !input.ref || input.ref.length > 8192
      || (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 128))
      || (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > 1000000))) throw new Error('对象读取请求无效。')
    return hostModules.get(sourceId).explorer.read(transport, input, signal)
  }
}

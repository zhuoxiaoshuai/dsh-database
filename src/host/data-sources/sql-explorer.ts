import type { SqlDataSourceId } from '../../shared/data-sources/types.ts'
import type { ExplorerProvider } from '../explorer-provider.ts'

const MAX_OFFSET = 100000
const decode = (text: string) => { try { return decodeURIComponent(text) } catch { throw new Error('对象引用无效。') } }
const offsetOf = (cursor?: string) => {
  if (!cursor) return 0
  if (!/^\d{1,6}$/.test(cursor) || Number(cursor) > MAX_OFFSET || Number(cursor) % 100 !== 0) throw new Error('分页游标无效。')
  return Number(cursor)
}
const schemaRef = (name: string) => `schema:${encodeURIComponent(name)}`
const objectRef = (schema: string, name: string) => `object:${encodeURIComponent(schema)}:${encodeURIComponent(name)}`

export function sqlExplorerProvider(id: SqlDataSourceId): ExplorerProvider {
  return {
    id,
    async list(transport, input, signal) {
      const offset = offsetOf(input.cursor)
      const search = input.search || ''
      if (search.length > 128) throw new Error('对象搜索词过长。')
      if (!input.parent) {
        const page = await transport.catalog({ kind: 'schemas', offset, search, refresh: input.refresh }, signal)
        return { sourceId: id, nodes: (page.items || []).map(row => ({ ref: schemaRef(String(row.name || '')), title: String(row.name || ''), kind: 'schema', hasChildren: true, metadata: row })).filter(node => node.title),
          ...(page.more ? { nextCursor: String(offset + 100) } : {}), complete: !page.more }
      }
      if (!input.parent.startsWith('schema:')) throw new Error('对象引用无效。')
      const schema = decode(input.parent.slice(7))
      if (!schema) throw new Error('对象引用无效。')
      const page = await transport.catalog({ kind: 'tables', schema, offset, search, refresh: input.refresh }, signal)
      return { sourceId: id, nodes: (page.items || []).map(row => ({ ref: objectRef(schema, String(row.name || '')), title: String(row.name || ''), kind: /view/i.test(String(row.kind || '')) ? 'view' : 'table', hasChildren: false, metadata: row })).filter(node => node.title),
        ...(page.more ? { nextCursor: String(offset + 100) } : {}), complete: !page.more }
    },
    async read(transport, input, signal) {
      const ref = input.ref || ''
      if (ref.startsWith('schema:')) return transport.catalog({ kind: 'schema', schema: decode(ref.slice(7)) }, signal)
      if (!ref.startsWith('object:')) throw new Error('对象引用无效。')
      const parts = ref.slice(7).split(':')
      if (parts.length !== 2 || !parts.every(Boolean)) throw new Error('对象引用无效。')
      return transport.catalog({ kind: 'table', schema: decode(parts[0]), table: decode(parts[1]) }, signal)
    },
  }
}

import type { ExplorerProvider } from '../../explorer-provider.ts'

const keyRef = (name: string) => `key:${encodeURIComponent(name)}`
const decodeKey = (ref: string) => {
  if (!ref.startsWith('key:')) throw new Error('对象引用无效。')
  try { const name = decodeURIComponent(ref.slice(4)); if (name) return name } catch { /* invalid encoding */ }
  throw new Error('对象引用无效。')
}

export const redisExplorer: ExplorerProvider = {
  id: 'redis',
  async list(transport, input, signal) {
    if (input.parent) throw new Error('Redis Key 列表不支持父节点。')
    const page = await transport.redis('redis-scan', { cursor: input.cursor || '0', match: input.search || '*', ...(input.database ? { database: input.database } : {}) }, signal)
    const keys = Array.isArray(page.keys) ? page.keys.filter((key): key is string => typeof key === 'string') : []
    const nextCursor = typeof page.cursor === 'string' ? page.cursor : '0'
    return { sourceId: 'redis', nodes: [...new Set(keys)].map(name => ({ ref: keyRef(name), title: name, kind: 'key', hasChildren: false })),
      ...(nextCursor !== '0' ? { nextCursor } : {}), complete: nextCursor === '0' }
  },
  read(transport, input, signal) {
    return transport.redis('redis-key', { key: decodeKey(input.ref), operation: 'read', cursor: input.cursor || '0', offset: input.offset || 0, ...(input.database ? { database: input.database } : {}) }, signal)
  },
}

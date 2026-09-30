import test from 'node:test'
import assert from 'node:assert/strict'
import { createExplorerRegistry, ExplorerService } from '../src/host/explorer-service.ts'

test('a test-only object provider can register without changing the common explorer', () => {
  const mock = { id: 'mock-source', list: async () => ({ sourceId: 'mock-source', nodes: [], complete: true }), read: async () => ({ title: 'item' }) }
  const registry = createExplorerRegistry([mock], ['mock-source'])
  assert.equal(registry.get('mock-source'), mock)
  assert.throws(() => registry.get('unknown'), /不支持/)
  assert.throws(() => createExplorerRegistry([], ['mock-source']), /缺少/)
  assert.throws(() => createExplorerRegistry([mock, mock], ['mock-source']), /重复/)
})

test('SQL object references and offsets are mapped by its provider', async () => {
  const calls = []
  const transport = {
    catalog: async input => {
      calls.push(input)
      if (input.kind === 'schemas') return { items: [{ name: 'APP' }], more: true }
      if (input.kind === 'tables') return { items: [{ name: 'ORDERS', kind: 'VIEW' }], more: false }
      return { columns: [{ name: 'ID' }] }
    },
    redis: async () => { throw new Error('SQL explorer called Redis') },
  }
  const explorer = new ExplorerService()
  const root = await explorer.list('oracle', transport, {})
  assert.equal(root.nodes[0].ref, 'schema:APP')
  assert.equal(root.nextCursor, '100')
  const tables = await explorer.list('oracle', transport, { parent: root.nodes[0].ref, cursor: '100' })
  assert.equal(tables.nodes[0].kind, 'view')
  assert.equal(tables.complete, true)
  assert.equal(calls[1].offset, 100)
  assert.deepEqual((await explorer.read('oracle', transport, { ref: tables.nodes[0].ref })).columns, [{ name: 'ID' }])
  await assert.rejects(explorer.list('oracle', transport, { cursor: '1' }), /游标/)
  await assert.rejects(explorer.read('oracle', transport, { ref: 'key:wrong' }), /引用/)
})

test('Redis explorer preserves SCAN cursor and does not invent child navigation', async () => {
  const requests = []
  const transport = {
    catalog: async () => { throw new Error('Redis explorer called SQL') },
    redis: async (action, input) => { requests.push({ action, input }); return action === 'redis-scan' ? { keys: ['a:b', 'a:b'], cursor: '41' } : { keyType: 'string', ttl: -1 } },
  }
  const explorer = new ExplorerService()
  const page = await explorer.list('redis', transport, { cursor: '0', search: 'a:*' })
  assert.deepEqual(page.nodes.map(node => node.title), ['a:b'])
  assert.equal(page.nextCursor, '41')
  assert.equal(page.complete, false)
  assert.equal((await explorer.read('redis', transport, { ref: page.nodes[0].ref })).keyType, 'string')
  assert.equal(requests[1].input.key, 'a:b')
  assert.equal(requests[0].input.database, undefined)
  await explorer.list('redis', transport, { cursor: '0', search: 'a:*', database: '2' })
  assert.equal(requests[2].input.database, '2')
  await assert.rejects(explorer.list('redis', transport, { parent: 'schema:x' }), /父节点/)
})

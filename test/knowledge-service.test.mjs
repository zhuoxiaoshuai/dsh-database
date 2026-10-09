import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKnowledgeRegistry } from './helpers/source-registries.ts'
import { KnowledgeService } from '../src/host/knowledge-service.ts'
import { SqlTemplateStore } from '../src/host/sql-template-store.ts'

test('a test-only knowledge source registers without changing common dispatch', () => {
  const mock = { id: 'mock-source', dispatch: (_store, connectionId, body) => ({ connectionId, action: body.action }) }
  const registry = createKnowledgeRegistry([mock], ['mock-source'])
  assert.deepEqual(registry.get('mock-source').dispatch({}, 'c1', { action: 'knowledge-search' }), { connectionId: 'c1', action: 'knowledge-search' })
  assert.throws(() => registry.get('unknown'), /不支持/)
  assert.throws(() => createKnowledgeRegistry([], ['mock-source']), /缺少/)
  assert.throws(() => createKnowledgeRegistry([mock, mock], ['mock-source']), /重复/)
})

test('knowledge dispatch is bound to the actual source and connection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-knowledge-service-'))
  try {
    const store = new SqlTemplateStore(root)
    const service = new KnowledgeService(store)
    const created = await service.dispatch('redis', 'redis-a', { action: 'knowledge-publish', text: 'GET customer:1', title: '查看客户' })
    assert.equal(created.sourceId, 'redis')
    assert.equal((await service.dispatch('redis', 'redis-a', { action: 'knowledge-search' })).items.length, 1)
    assert.equal((await service.dispatch('redis', 'redis-b', { action: 'knowledge-search' })).items.length, 0)
    assert.throws(() => service.dispatch('redis', 'redis-b', { action: 'knowledge-get', id: created.id }), /不存在/)
    assert.throws(() => service.dispatch('mysql', 'redis-a', { action: 'knowledge-search' }), /Redis 连接/)
    assert.throws(() => service.dispatch('redis', 'redis-a', { action: 'template-search' }), /SQL 连接/)
    assert.throws(() => service.dispatch('redis', '', { action: 'knowledge-search' }), /connectionId/)
    const sql = await store.publish({ sql: 'SELECT 1', dialect: 'mysql', connectionId: 'mysql-a', title: '常用查询', action: 'create' })
    assert.equal((await service.dispatch('mysql', 'mysql-a', { action: 'template-search', query: '常用' })).items[0].id, sql.id)
    assert.equal((await service.dispatch('mysql', 'mysql-a', { action: 'template-get', id: sql.id })).id, sql.id)
    assert.throws(() => service.dispatch('mysql', 'mysql-b', { action: 'template-get', id: sql.id }), /不属于此连接/)
    assert.throws(() => service.dispatch('oracle', 'mysql-a', { action: 'template-get', id: sql.id, dialect: 'mysql' }), /不匹配/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

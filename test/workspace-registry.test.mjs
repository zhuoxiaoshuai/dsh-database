import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspaceRegistry } from '../src/client/workspace/parts/workspace-registry.ts'

test('a test-only source can supply its own workspace without changing the shared registry', () => {
  const mock = { id: 'mock-source', render: context => ({ title: context.title }) }
  const registry = createWorkspaceRegistry([mock], ['mock-source'])
  assert.deepEqual(registry.ids(), ['mock-source'])
  assert.deepEqual(registry.get('mock-source').render({ title: '模拟总览' }), { title: '模拟总览' })
  assert.throws(() => registry.get('unknown'), /不支持此数据源/)
})

test('workspace registry rejects missing, duplicate and invalid source implementations', () => {
  const mock = { id: 'mock-source', render: () => null }
  assert.throws(() => createWorkspaceRegistry([], ['mock-source']), /缺少数据源工作台/)
  assert.throws(() => createWorkspaceRegistry([mock, mock], ['mock-source']), /无效或重复/)
  assert.throws(() => createWorkspaceRegistry([{ id: 'mock-source' }], ['mock-source']), /无效或重复/)
  assert.throws(() => createWorkspaceRegistry([mock], ['mock-source', 'mock-source']), /声明重复/)
})

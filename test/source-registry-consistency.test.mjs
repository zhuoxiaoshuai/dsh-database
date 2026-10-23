import test from 'node:test'
import assert from 'node:assert/strict'
import { hostModules, getSourceRuntime } from '../src/host/data-sources/modules.ts'
import { getSqlDataSource } from '../src/host/data-sources/sql-registry.mjs'
import { getRedisDataSource } from '../src/host/data-sources/redis-registry.mjs'

/**
 * provider-registry.mjs 对 driver/policy/maintenance/recovery 能力的额外校验是有意的差异，
 * 这里只对齐三层注册共同暴露的 runtime 元数据。
 */
const RUNTIME_FIELDS = ['id', 'workerEntry', 'requiresPassword', 'actions', 'documentKind']

const sources = [
  ['mysql', () => getSqlDataSource('mysql')],
  ['oracle', () => getSqlDataSource('oracle')],
  ['redis', () => getRedisDataSource('redis')],
]

test('data source registries expose identical runtime metadata', () => {
  for (const [id, getProvider] of sources) {
    const providerRuntime = getProvider().runtime
    const moduleRuntime = hostModules.get(id).runtime
    const sourceRuntime = getSourceRuntime(id)
    assert.equal(providerRuntime.id, id, `provider 注册表中 ${id} 的 runtime.id 不匹配`)
    for (const field of RUNTIME_FIELDS) {
      assert.deepEqual(moduleRuntime[field], providerRuntime[field], `modules.ts 的 ${id} runtime.${field} 与 provider 注册表不一致`)
      assert.deepEqual(sourceRuntime[field], providerRuntime[field], `getSourceRuntime 的 ${id} runtime.${field} 与 provider 注册表不一致`)
    }
  }
})

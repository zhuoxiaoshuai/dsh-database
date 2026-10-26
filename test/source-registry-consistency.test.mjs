import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { hostModules, getSourceRuntime } from '../src/host/data-sources/modules.ts'
import { getSqlDataSource, registeredDataSources as registeredSqlDataSources } from '../src/host/data-sources/sql-registry.mjs'
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

test('两套注册层的注册 id 集合一致', () => {
  const providerIds = [...registeredSqlDataSources(), 'redis']
  const moduleProviderIds = hostModules.ids().filter(id => ['sql', 'redis'].includes(hostModules.get(id).family))
  assert.deepEqual(new Set(providerIds), new Set(moduleProviderIds), 'Provider 注册表与 hostModules 的 SQL/Redis 注册集合不一致')
  assert.deepEqual([...registeredSqlDataSources()], ['mysql', 'oracle'], 'SQL Provider 注册表应恰好是 mysql/oracle')
  assert.deepEqual(hostModules.ids().filter(id => !providerIds.includes(id)), ['kafka', 'nacos'], '没有 .mjs Provider 的来源应恰好是 kafka/nacos')
  for (const id of ['kafka', 'nacos']) assert.throws(() => getSqlDataSource(id), /不是 SQL 数据源/, `${id} 不应进入 SQL 注册表`)
})

test('两套注册层共享同一份 runtime 声明（对象引用一致）', () => {
  for (const [id, getProvider] of sources) {
    const providerRuntime = getProvider().runtime
    assert.strictEqual(hostModules.get(id).runtime, providerRuntime, `hostModules 的 ${id} runtime 与 provider 注册表不是同一个对象`)
    assert.strictEqual(getSourceRuntime(id), providerRuntime, `getSourceRuntime 的 ${id} runtime 与 provider 注册表不是同一个对象`)
    for (const field of ['workerEntry', 'actions', 'requiresPassword', 'documentKind']) {
      assert.strictEqual(hostModules.get(id).runtime[field], providerRuntime[field], `modules.ts 的 ${id} runtime.${field} 与 provider 注册表不一致`)
    }
  }
})

test('每个来源的 runtime 只在 runtime.mjs 声明一次', () => {
  const read = file => readFileSync(new URL(`../src/host/data-sources/${file}`, import.meta.url), 'utf8')
  for (const id of ['mysql', 'oracle', 'redis', 'kafka', 'nacos']) {
    assert.match(read(`${id}/module.ts`), /from ['"]\.\/runtime\.mjs['"]/, `${id}/module.ts 必须复用 ./runtime.mjs 的 runtime 声明`)
    assert.doesNotMatch(read(`${id}/module.ts`), /workerEntry:\s*['"]/, `${id}/module.ts 不得自带 runtime 字面量`)
  }
  for (const id of ['mysql', 'oracle', 'redis']) {
    assert.match(read(`${id}/index.mjs`), /from ['"]\.\/runtime\.mjs['"]/, `${id}/index.mjs 必须复用 ./runtime.mjs 的 runtime 声明`)
    assert.doesNotMatch(read(`${id}/index.mjs`), /workerEntry:\s*['"]/, `${id}/index.mjs 不得自带 runtime 字面量`)
  }
})

test('runtime 形状校验单源于 runtime-contract.mjs', () => {
  const read = file => readFileSync(new URL(`../src/host/data-sources/${file}`, import.meta.url), 'utf8')
  assert.match(read('runtime-contract.mjs'), /\[a-z0-9-\]\*-worker/, 'runtime-contract.mjs 应持有 workerEntry 形状规则')
  for (const file of ['modules.ts', 'provider-registry.mjs']) {
    assert.match(read(file), /from ['"]\.\/runtime-contract\.mjs['"]/, `${file} 必须复用 runtime-contract.mjs 的形状校验`)
    assert.doesNotMatch(read(file), /\[a-z0-9-\]\*-worker/, `${file} 不得再自带 runtime 形状规则`)
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { createDataSourceRegistry, getDataSource, getRedisDataSource, registeredDataSources, registeredAllDataSources } from '../src/host/data-sources/registry.mjs'
import { createRuntimeRegistry, getSourceRuntime, registeredSourceRuntimes } from '../src/host/data-sources/runtime-registry.mjs'
import { getSqlDataSource as getSqlRuntimeProvider, registeredDataSources as registeredSqlRuntimeProviders } from '../src/host/data-sources/sql-registry.mjs'
import { getRedisDataSource as getRedisRuntimeProvider } from '../src/host/data-sources/redis-registry.mjs'
import { clientDataSource, clientWorkspaceDescriptor, supportedDataSources } from '../src/shared/data-sources/registry.ts'

test('host and client register the same isolated SQL sources and capabilities', () => {
  assert.deepEqual(registeredDataSources(), ['mysql', 'oracle'])
  assert.deepEqual(registeredSqlRuntimeProviders(), registeredDataSources())
  for (const id of registeredDataSources()) assert.equal(getSqlRuntimeProvider(id), getDataSource(id))
  assert.equal(getRedisRuntimeProvider('redis'), getRedisDataSource('redis'))
  assert.deepEqual([...supportedDataSources], registeredDataSources())
  for (const id of registeredDataSources()) {
    const host = getDataSource(id), client = clientDataSource(id)
    assert.equal(host.id, client.id)
    assert.equal(host.family, 'sql')
    assert.equal(client.family, 'sql')
    assert.equal(host.capabilities.showIndex, client.supportsShowIndex)
    assert.equal(host.capabilities.columnComment, client.supportsColumnComment)
    assert.deepEqual(host.connection.fingerprintSuffix('sid'), client.fingerprintSuffix('sid'))
    assert.deepEqual(host.connection.fingerprintSuffix('service'), client.fingerprintSuffix('service'))
    for (const [target, mode] of [['', 'service'], ['ORCLPDB1', 'service'], ['ORCL', 'sid'], ['bad)(SID=x', 'sid']]) {
      const rejected = fn => { try { fn(target, mode); return false } catch { return true } }
      assert.equal(rejected(host.connection.validateTarget), rejected(client.validateTarget))
    }
  }
  assert.throws(() => getDataSource('unknown'), /不支持/)
  assert.throws(() => clientDataSource('unknown'), /不支持/)
})

test('registry rejects duplicates and incomplete provider contracts', () => {
  const mysql = getDataSource('mysql')
  assert.throws(() => createDataSourceRegistry([mysql, mysql]), /重复/)
  assert.throws(() => createDataSourceRegistry([{ ...mysql, connection: {} }]), /连接能力不完整/)
  assert.throws(() => createDataSourceRegistry([{ ...mysql, runtime: {} }]), /运行能力不完整/)
  assert.throws(() => createDataSourceRegistry([{ ...mysql, catalog: {} }]), /目录能力不完整/)
  assert.throws(() => createDataSourceRegistry([{ ...mysql, policy: {} }]), /策略能力不完整/)
  assert.throws(() => createDataSourceRegistry([{ ...mysql, maintenance: {} }]), /维护能力不完整/)
  assert.throws(() => createDataSourceRegistry([{ ...mysql, recovery: {} }]), /恢复能力不完整/)
})

test('connection runtime selection and credential rules belong to the registered source', () => {
  const mysql = getSourceRuntime('mysql'), oracle = getSourceRuntime('oracle'), redis = getSourceRuntime('redis'), kafka = getSourceRuntime('kafka')
  assert.deepEqual(registeredSourceRuntimes(), [...registeredAllDataSources(), 'kafka'])
  for (const id of registeredAllDataSources()) assert.equal(getSourceRuntime(id), id === 'redis' ? getRedisDataSource(id).runtime : getDataSource(id).runtime)
  assert.equal(mysql.workerEntry, 'connection-worker.mjs')
  assert.equal(oracle.workerEntry, 'connection-worker.mjs')
  assert.equal(redis.workerEntry, 'redis-worker.mjs')
  assert.equal(kafka.workerEntry, 'kafka-worker.mjs')
  assert.equal(mysql.requiresPassword, true)
  assert.equal(oracle.requiresPassword, true)
  assert.equal(redis.requiresPassword, false)
  assert.equal(redis.usesCustomCa({ tls: true }), true)
  assert.equal(redis.usesCustomCa({ tls: false }), false)
  assert.equal(mysql.documentKind, 'sql')
  assert.equal(oracle.documentKind, 'sql')
  assert.equal(redis.documentKind, 'command')
  assert.equal(kafka.documentKind, 'command')
  for (const id of registeredAllDataSources()) {
    const client = clientWorkspaceDescriptor(id).connection
    assert.equal(client.requiresPassword, getSourceRuntime(id).requiresPassword)
    assert.equal(typeof client.validateConnectionTarget, 'function')
    assert.equal(typeof client.connectionExtras, 'function')
    assert.equal(typeof client.connectionFingerprintSuffix, 'function')
  }
  assert.deepEqual(mysql.actions, ['catalog', 'query', 'manual-query', 'browse', 'maintenance'])
  assert.deepEqual(redis.actions, ['redis-command', 'redis-scan', 'redis-key-suggest', 'redis-key'])
  assert.deepEqual(kafka.actions, ['kafka-topics', 'kafka-describe', 'kafka-peek', 'kafka-groups', 'kafka-group'])
  assert.throws(() => getSourceRuntime('unknown'), /不支持/)
  assert.throws(() => createRuntimeRegistry([mysql, mysql]), /重复/)
  assert.throws(() => createRuntimeRegistry([{ ...mysql, actions: ['query', 'query'] }]), /运行能力不完整/)
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../src/host/data-sources')
  for (const file of ['runtime-registry.mjs', 'mysql/runtime.mjs', 'oracle/runtime.mjs', 'redis/runtime.mjs']) {
    assert.doesNotMatch(readFileSync(resolve(root, file), 'utf8'), /\b(?:mysql2|oracledb|from ['"]redis['"]|createClient|driver\.mjs)\b/)
  }
})

test('each provider owns catalog failure, readonly retry, and uncertain DDL classification', () => {
  const mysql = getDataSource('mysql'), oracle = getDataSource('oracle')
  assert.equal(mysql.recovery.isFatalCatalog({ code: 'ER_TABLEACCESS_DENIED_ERROR' }), false)
  assert.equal(mysql.recovery.isFatalCatalog({ code: 'PROTOCOL_CONNECTION_LOST' }), true)
  assert.equal(mysql.recovery.shouldRetryReadonly({ code: 'PROTOCOL_CONNECTION_LOST' }), true)
  assert.equal(mysql.recovery.shouldRetryReadonly({ code: 'PROTOCOL_SEQUENCE_TIMEOUT' }), false)
  assert.equal(oracle.recovery.isFatalCatalog({ code: 'ORA-01031' }), false)
  assert.equal(oracle.recovery.isFatalCatalog({ code: 'ORA-03113' }), true)
  assert.equal(oracle.recovery.shouldRetryReadonly({ code: 'ORA-03113' }), true)
  assert.equal(oracle.recovery.shouldRetryReadonly({ code: 'ORA-12170' }), false)
  assert.equal(oracle.maintenance.isUncertainDdlError({ code: 'ORA-03113' }), true)
  assert.equal(oracle.maintenance.isUncertainDdlError({ code: 'ORA-02293' }), false)
})

test('provider source trees do not import one another or leak driver code to client descriptors', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../src')
  for (const id of registeredDataSources()) {
    const dir = resolve(root, 'host/data-sources', id)
    for (const entry of readdirSync(dir)) {
      if (!/\.(?:mjs|ts)$/.test(entry)) continue
      const source = readFileSync(resolve(dir, entry), 'utf8')
      const other = id === 'mysql' ? 'oracle' : 'mysql'
      assert.doesNotMatch(source, new RegExp(`(?:from|import\\()\\s*['\"](?:\\.\\./)+${other}/`))
    }
    const client = readFileSync(resolve(root, 'shared/data-sources', `${id}.ts`), 'utf8')
    assert.doesNotMatch(client, /mysql2|oracledb|node:|src\/host/)
  }
})

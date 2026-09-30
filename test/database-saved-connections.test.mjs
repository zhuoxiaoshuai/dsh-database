import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { memoryPasswordProtector, SavedDatabaseConnections, uniqueCopyName } from '../src/host/saved-connections.ts'
import { ConnectionService } from '../src/host/connection-service.ts'
import { hashConversationId } from '../src/host/conversation-workbench-store.ts'
import { connectionInput, temporaryDirectory } from './helpers.mjs'

const input = connectionInput()

const row = (id = 'connection-1') => ({
  id, name: input.name, dialect: input.dialect, environment: input.environment,
  database: input.database, version: 'MySQL 8', live: true, generation: 'generation-secret',
  sql: 'DROP TABLE sensitive', result: { rows: [['secret']] },
  settings: { ...input, password: input.password },
  workbench: {
    queryTabs: [{ id: 'tab-1', name: '草稿', sql: 'SELECT 1', result: { rows: [['secret']] } }],
    templates: ['SELECT   1'],
    history: ['SELECT 1'],
  },
})

function saveFixture(directory, value = row()) {
  new SavedDatabaseConnections(directory).save({ connections: [value], lastActiveId: value.id })
}

function saveLegacyWorkbench(directory, value = row()) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'database-workspace.json'), JSON.stringify({
    version: 2,
    lastActiveId: value.id,
    connections: [{
      id: value.id,
      settings: { ...input, password: undefined },
      workbench: value.workbench,
    }],
  }))
}

test('saved connection storage keeps only the allowlisted connection fields', t => {
  const { directory, cleanup } = temporaryDirectory('database-saved-fields-')
  t.after(cleanup)
  const store = new SavedDatabaseConnections(directory)
  store.save({ connections: [row()], lastActiveId: 'connection-1' })
  const persisted = JSON.parse(readFileSync(store.path, 'utf8'))
  assert.equal(persisted.version, 3)
  assert.deepEqual(Object.keys(persisted.connections[0]).sort(), ['id', 'settings'])
  assert.equal(Object.hasOwn(persisted.connections[0], 'live'), false)
  assert.equal(Object.hasOwn(persisted.connections[0], 'generation'), false)
  assert.equal(Object.hasOwn(persisted.connections[0], 'workbench'), false)
  assert.equal(Object.hasOwn(persisted.connections[0].settings, 'password'), false)
  assert.doesNotMatch(JSON.stringify(persisted), /secret|DROP TABLE|generation-secret|SELECT 1/)
})

test('legacy connection drafts migrate into the opening conversation only', async t => {
  const { directory, cleanup } = temporaryDirectory('database-saved-draft-migrate-')
  t.after(cleanup)
  saveLegacyWorkbench(directory)
  const service = new ConnectionService(() => true, directory)
  t.after(() => service.dispose())
  const first = service.snapshot('owner-a').connections[0]
  assert.equal(first.workbench?.queryTabs?.[0].sql, 'SELECT 1')
  const second = service.snapshot('owner-b').connections[0]
  assert.equal(second.workbench?.queryTabs?.[0].sql, 'SELECT 1')
  service.saveWorkbench('owner-a', first.id, { queryTabs: [{ id: 'tab-2', name: 'A', sql: 'SELECT a' }], history: ['SELECT a'] })
  assert.equal(service.snapshot('owner-a').connections[0].workbench?.queryTabs?.[0].sql, 'SELECT a')
  assert.equal(service.snapshot('owner-b').connections[0].workbench?.queryTabs?.[0].sql, 'SELECT 1')
  const persisted = JSON.parse(readFileSync(join(directory, 'database-workspace.json'), 'utf8'))
  assert.equal(Object.hasOwn(persisted.connections[0], 'workbench'), false)
})

test('workspace file is shared across conversations', t => {
  const { directory, cleanup } = temporaryDirectory('database-saved-shared-')
  t.after(cleanup)
  saveFixture(directory)
  assert.equal(new SavedDatabaseConnections(directory).load().connections.length, 1)
})

test('a damaged file is retained and cannot be overwritten', t => {
  const { directory, cleanup } = temporaryDirectory('database-saved-broken-')
  t.after(cleanup)
  const store = new SavedDatabaseConnections(directory)
  mkdirSync(directory, { recursive: true })
  writeFileSync(store.path, '{ damaged file', 'utf8')
  const before = readFileSync(store.path, 'utf8')

  assert.throws(() => store.load(), /无法读取，原文件已保留/)
  assert.throws(() => store.save({ connections: [row()] }), /损坏，未覆盖原文件/)
  assert.equal(readFileSync(store.path, 'utf8'), before)
})

test('legacy per-conversation files migrate into the workspace file', t => {
  const { directory, cleanup } = temporaryDirectory('database-saved-migrate-')
  t.after(cleanup)
  const legacyDir = join(directory, 'database-connections')
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(join(legacyDir, 'old.json'), JSON.stringify({ version: 1, owner: 'owner-a', connections: [{ id: 'connection-1', settings: { ...input, password: '' } }] }))
  const loaded = new SavedDatabaseConnections(directory).load()
  assert.equal(loaded.connections[0].id, 'connection-1')
  assert.ok(JSON.parse(readFileSync(join(directory, 'database-workspace.json'), 'utf8')).connections.length)
})

test('offline disconnect preserves a saved connection and remove deletes it', async t => {
  const { directory, cleanup } = temporaryDirectory('database-saved-offline-')
  t.after(cleanup)
  saveFixture(directory)
  const service = new ConnectionService(() => true, directory)
  t.after(() => service.dispose())

  assert.equal(service.list('owner-a')[0].live, false)
  await service.disconnect('owner-a', 'connection-1')
  assert.equal(service.list('owner-b')[0].id, 'connection-1')
  await service.remove('owner-a', 'connection-1')
  assert.deepEqual(service.list('owner-a'), [])
})

test('saved connections survive service disposal and restore offline', async t => {
  const { directory, cleanup } = temporaryDirectory('database-saved-restore-')
  t.after(cleanup)
  saveFixture(directory)
  const first = new ConnectionService(() => true, directory)
  assert.equal(first.list('owner-a').length, 1)
  await first.dispose()
  const restored = new ConnectionService(() => true, directory)
  t.after(() => restored.dispose())
  assert.deepEqual(restored.list('owner-a').map(({ id, live, generation }) => ({ id, live, generation })), [{ id: 'connection-1', live: false, generation: undefined }])
})

test('invalid sessions cannot read or mutate saved connections', async t => {
  const { directory, cleanup } = temporaryDirectory('database-saved-invalid-owner-')
  t.after(cleanup)
  saveFixture(directory)
  const service = new ConnectionService(owner => owner === 'owner-a', directory)
  t.after(() => service.dispose())

  assert.throws(() => service.list('owner-b'), /当前对话已失效/)
  await assert.rejects(service.disconnect('owner-b', 'connection-1'), /当前对话已失效/)
  await assert.rejects(service.remove('owner-b', 'connection-1'), /当前对话已失效/)
})

test('remembered passwords are ciphertext only and can reopen a connection', async t => {
  const { directory, cleanup } = temporaryDirectory('database-saved-password-')
  t.after(cleanup)
  const workerUrl = new URL(pathToFileURL(join(process.cwd(), 'test/fixtures/database-worker.mjs')))
  const service = new ConnectionService(() => true, directory, workerUrl, memoryPasswordProtector)
  t.after(() => service.dispose())
  const connected = await service.open('owner-a', { ...input, rememberPassword: true }, false)
  const persisted = readFileSync(join(directory, 'database-workspace.json'), 'utf8')
  assert.doesNotMatch(persisted, /secret/)
  assert.equal(connected.hasPassword, true)
  assert.match(persisted, /protectedPassword/)
  await service.dispose()
  const restored = new ConnectionService(() => true, directory, workerUrl, memoryPasswordProtector)
  t.after(() => restored.dispose())
  const live = await restored.open('owner-b', { ...input, password: '', useSavedPassword: true, rememberPassword: true }, false, connected.id)
  assert.equal(live.live, true)
  assert.equal(live.id, connected.id)
  await restored.dispose()
  const again = new ConnectionService(() => true, directory, workerUrl, memoryPasswordProtector)
  t.after(() => again.dispose())
  await again.restoreRemembered('owner-c')
  const restoredLive = again.list('owner-c').find(item => item.id === connected.id)
  assert.equal(restoredLive?.live, true)
})

test('reusing a live remembered login keeps the session and serializes concurrent updates', async t => {
  const { directory, cleanup } = temporaryDirectory('database-saved-reuse-')
  t.after(cleanup)
  const workerUrl = new URL(pathToFileURL(join(process.cwd(), 'test/fixtures/database-worker.mjs')))
  const service = new ConnectionService(() => true, directory, workerUrl, memoryPasswordProtector)
  t.after(() => service.dispose())
  const connected = await service.open('owner-a', { ...input, rememberPassword: true }, false)
  const reused = await service.update('owner-a', connected.id, { ...input, password: '', useSavedPassword: true, rememberPassword: true })
  assert.equal(reused.generation, connected.generation)
  assert.equal(reused.live, true)
  const renamed = await service.update('owner-a', connected.id, { ...input, name: '127.0.0.1:1521', password: '', useSavedPassword: true, rememberPassword: true })
  assert.equal(renamed.name, '127.0.0.1:1521')
  assert.equal(renamed.generation, connected.generation)
  assert.equal(service.list('owner-a').find(item => item.id === connected.id)?.name, '127.0.0.1:1521')
  const pair = await Promise.all([
    service.update('owner-a', connected.id, { ...input, password: '', useSavedPassword: true, rememberPassword: true }),
    service.update('owner-a', connected.id, { ...input, password: '', useSavedPassword: true, rememberPassword: true }),
  ])
  assert.equal(pair[0].generation, connected.generation)
  assert.equal(pair[1].generation, connected.generation)
})

test('workspace file in Desktop harness is used when DSH_HOME is empty', t => {
  const { directory, cleanup } = temporaryDirectory('database-saved-desktop-home-')
  t.after(cleanup)
  const appdata = join(directory, 'AppData')
  const desktop = join(appdata, 'dsh-desktop', 'harness', 'database')
  mkdirSync(desktop, { recursive: true })
  writeFileSync(join(desktop, 'database-workspace.json'), JSON.stringify({
    version: 3,
    connections: [{ id: 'keep-me', settings: { ...input, password: undefined } }],
  }))
  const previousHome = process.env.DSH_HOME
  const previousApp = process.env.APPDATA
  delete process.env.DSH_HOME
  process.env.APPDATA = appdata
  try {
    const loaded = new SavedDatabaseConnections().load()
    assert.equal(loaded.connections[0].id, 'keep-me')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousApp === undefined) delete process.env.APPDATA
    else process.env.APPDATA = previousApp
  }
})

test('one invalid saved connection does not drop the rest', t => {
  const { directory, cleanup } = temporaryDirectory('database-saved-skip-bad-')
  t.after(cleanup)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'database-workspace.json'), JSON.stringify({
    version: 3,
    connections: [
      { id: 'bad', settings: { dialect: 'mysql' } },
      { id: 'keep-me', settings: { ...input, password: undefined } },
    ],
  }))
  const loaded = new SavedDatabaseConnections(directory).load()
  assert.deepEqual(loaded.connections.map(row => row.id), ['keep-me'])
})

test('snapshot still lists connections when conversation layout is unreadable', t => {
  const { directory, cleanup } = temporaryDirectory('database-saved-layout-')
  t.after(cleanup)
  saveFixture(directory)
  const layoutDir = join(directory, 'conversation-workbenches')
  mkdirSync(layoutDir, { recursive: true })
  writeFileSync(join(layoutDir, `${hashConversationId('owner-a')}.json`), '{ damaged', 'utf8')
  const service = new ConnectionService(() => true, directory)
  t.after(() => service.dispose())
  assert.equal(service.snapshot('owner-a').connections[0].id, 'connection-1')
})

test('importConnections saves offline drafts, dedupes, and never stores passwords', async t => {
  const { directory, cleanup } = temporaryDirectory('database-import-')
  t.after(cleanup)
  const service = new ConnectionService(() => true, directory, undefined, memoryPasswordProtector)
  t.after(() => service.dispose())
  const first = service.importConnections('owner-a', [
    { name: 'navicat-1', dialect: 'mysql', host: '10.0.0.1', port: 3306, username: 'root' },
    { name: 'navicat-1b', dialect: 'mysql', host: '10.0.0.1', port: 3306, username: 'root', password: 'leaked' },
    { name: 'app-db', dialect: 'mysql', host: '10.0.0.1', port: 3306, database: 'app', username: 'root' },
    { dialect: 'oracle', host: '10.0.0.2', port: 1521, username: 'scott' },
    { name: 'orcl', dialect: 'oracle', host: '10.0.0.2', port: 1521, database: 'ORCLPDB1', username: 'scott', oracleMode: 'service' },
  ])
  assert.equal(first.created.length, 3)
  assert.equal(first.skipped.length, 2)
  assert.equal(first.skipped.filter(item => item.reason === 'duplicate').length, 1)
  assert.ok(first.skipped.some(item => item.reason === 'invalid' && /Oracle/.test(item.message || '')))
  assert.equal(first.created.every(item => item.hasPassword === false && item.live === false), true)
  const persisted = JSON.parse(readFileSync(join(directory, 'database-workspace.json'), 'utf8'))
  assert.equal(JSON.stringify(persisted).includes('leaked'), false)
  assert.equal(persisted.connections.every(row => !row.protectedPassword), true)
  const again = service.importConnections('owner-a', [
    { dialect: 'mysql', host: '10.0.0.1', port: 3306, database: 'app', username: 'root' },
    { dialect: 'oracle', host: '10.0.0.2', port: 1521, database: 'ORCLPDB1', username: 'scott', oracleMode: 'service' },
  ])
  assert.equal(again.created.length, 0)
  assert.equal(again.skipped.every(item => item.reason === 'duplicate'), true)
  await assert.rejects(service.open('owner-a', {
    name: 'x', dialect: 'mysql', host: '10.0.0.1', port: 3306, database: '', oracleMode: 'service', username: 'root', password: '', environment: 'sit',
  }, false), /请输入密码/)
})

test('uniqueCopyName appends 副本 and increments', () => {
  assert.equal(uniqueCopyName('订单库', []), '订单库 副本')
  assert.equal(uniqueCopyName('订单库', ['订单库', '订单库 副本']), '订单库 副本 2')
  assert.equal(uniqueCopyName('订单库 副本', ['订单库 副本']), '订单库 副本 2')
  const long = uniqueCopyName('a'.repeat(80), [])
  assert.equal(long.length, 80)
  assert.ok(long.endsWith('副本'))
})

test('duplicate copies settings and saved password under a new id', async t => {
  const { directory, cleanup } = temporaryDirectory('database-duplicate-')
  t.after(cleanup)
  const workerUrl = new URL(pathToFileURL(join(process.cwd(), 'test/fixtures/database-worker.mjs')))
  const service = new ConnectionService(() => true, directory, workerUrl, memoryPasswordProtector)
  t.after(() => service.dispose())
  const connected = await service.open('owner-a', { ...input, rememberPassword: true }, false)
  service.saveWorkbench('owner-a', connected.id, { visibleSchemas: ['app'] })
  const copy = await service.duplicate('owner-a', connected.id)
  assert.notEqual(copy.id, connected.id)
  assert.equal(copy.name, `${input.name} 副本`)
  assert.equal(copy.live, false)
  assert.equal(copy.hasPassword, true)
  assert.deepEqual(copy.workbench?.visibleSchemas, ['app'])
  assert.equal(copy.settings.host, connected.settings.host)
  const second = await service.duplicate('owner-a', connected.id)
  assert.equal(second.name, `${input.name} 副本 2`)
  const opened = await service.update('owner-a', copy.id, { ...copy.settings, password: '', useSavedPassword: true, rememberPassword: true })
  assert.equal(opened.live, true)
  assert.equal(opened.id, copy.id)
  assert.notEqual(opened.id, connected.id)
})

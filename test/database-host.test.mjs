import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerDatabase, tryRegisterDatabase } from '../src/host/register.ts'
import { connectionInput, temporaryDirectory } from './helpers.mjs'

const workerUrl = pathToFileURL(join(process.cwd(), 'test/fixtures/database-worker.mjs'))

function fixture(t, rejection) {
  const oldHome = process.env.DSH_HOME
  const directory = temporaryDirectory(t, 'database-host-')
  process.env.DSH_HOME = directory
  const routes = new Map(), tools = new Map(), listeners = new Map()
  const ctx = {
    sessions: { get: id => id === 'conversation-a' ? { id } : undefined },
    connection: { requestRejection: () => rejection },
    webServer: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } },
    tools: { register: tool => tools.set(tool.name, tool) },
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
  }
  const registration = registerDatabase(ctx, workerUrl)
  t.after(async () => {
    await registration.dispose()
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  })
  return { routes, tools, listeners }
}

function invoke(route, { method = 'GET', owner = 'conversation-a', body } = {}) {
  const payload = body ? Buffer.from(JSON.stringify(body)) : undefined
  return new Promise(resolve => {
    const response = {
      status: 200, headers: {}, body: '', destroyed: false, writableEnded: false,
      setHeader(name, value) { this.headers[name] = value },
      writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers) },
      end(text = '') { this.body += String(text); this.writableEnded = true; resolve(this) },
      once() {}, off() {},
    }
    const request = {
      method,
      url: `/plugins/database/connections?conversationId=${owner}`,
      headers: body ? { 'content-type': 'application/json' } : {},
      async *[Symbol.asyncIterator]() { if (payload) yield payload },
    }
    route.handler(request, response)
  })
}

const connectInput = connectionInput()

test('database host route requires DSH authentication before owner lookup', async t => {
  const { routes } = fixture(t, 401)
  const response = await invoke(routes.get('/plugins/database/connections'))
  assert.equal(response.status, 401)
  assert.equal(JSON.parse(response.body).error, '需要通过 DSH 认证访问，请刷新工作台。')
})

test('database host keeps owners isolated and AI status exposes no business data', async t => {
  const { routes, tools } = fixture(t)
  const route = routes.get('/plugins/database/connections')
  const valid = await invoke(route)
  assert.equal(valid.status, 200)
  const snapshot = JSON.parse(valid.body)
  assert.deepEqual(snapshot.connections, [])
  assert.equal(snapshot.openIds, undefined)
  assert.equal(typeof snapshot.passwordStorage, 'boolean')
  assert.equal(snapshot.passwordStorage, process.platform === 'win32')
  const missing = await invoke(route, { owner: 'missing' })
  assert.equal(missing.status, 200)
  assert.deepEqual(JSON.parse(missing.body).connections, [])
  const empty = await invoke(route, { owner: '' })
  assert.equal(empty.status, 404)
  assert.equal(JSON.parse(empty.body).error, '当前对话已失效，请刷新工作台。')
  const tooLong = await invoke(route, { owner: 'x'.repeat(161) })
  assert.equal(tooLong.status, 404)
  const status = JSON.parse(await tools.get('database_status').execute({}, { agent: { session: { id: 'conversation-a' } } }))
  assert.equal(status.stage, 'ready')
  // 源码直跑拿不到构建期注入的版本号，回落 'dev'；打包产物才会是真实版本
  assert.equal(status.pluginVersion, 'dev')
  assert.equal(status.templates.published, 0)
  assert.ok(Array.isArray(status.connections))
  assert.ok(status.note.includes('查库用 database_*'))
  assert.equal(JSON.stringify(status).includes('password'), false)
  assert.equal(tools.has('database_list_connections'), false)
  assert.equal(tools.has('database_query_readonly'), false)
  assert.ok(tools.has('database_catalog'))
  assert.ok(tools.has('database_execute_sql'))
  assert.ok(tools.has('database_templates'))
  assert.ok(tools.has('database_read_collab'))
  assert.ok(tools.has('database_import_connections'))
})

test('AI import connections skips duplicates and does not accept passwords', async t => {
  const { routes, tools } = fixture(t)
  await assert.rejects(tools.get('database_import_connections').execute({
    connections: [{ name: 'x', dialect: 'mysql', host: 'db.test', port: 3306, username: 'reader', password: 'should-ignore' }],
  }, { agent: { session: { id: 'conversation-a' } } }), /password/)
  const imported = JSON.parse(await tools.get('database_import_connections').execute({
    connections: [
      { name: 'from-navicat', dialect: 'mysql', host: 'db.test', port: 3306, username: 'reader' },
      { name: 'from-navicat-2', dialect: 'mysql', host: 'db.test', port: 3306, username: 'reader' },
    ],
  }, { agent: { session: { id: 'conversation-a' } } }))
  assert.equal(imported.created.length, 1)
  assert.equal(imported.skipped.length, 1)
  assert.equal(imported.skipped[0].reason, 'duplicate')
  assert.equal(imported.created[0].hasPassword, false)
  const snapshot = JSON.parse((await invoke(routes.get('/plugins/database/connections'))).body)
  assert.equal(snapshot.connections.length, 1)
  assert.equal(snapshot.connections[0].hasPassword, false)
  assert.equal(snapshot.connections[0].live, false)
})

test('workbench action persists visibleSchemas across snapshot reload', async t => {
  const { routes } = fixture(t)
  const route = routes.get('/plugins/database/connections')
  const connected = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'connect', input: connectInput } })).body)
  assert.ok(connected.id)
  const saved = JSON.parse((await invoke(route, {
    method: 'POST',
    body: { action: 'workbench', id: connected.id, workbench: { visibleSchemas: ['app', 'hr'] } },
  })).body)
  assert.deepEqual(saved.workbench.visibleSchemas, ['app', 'hr'])
  const snapshot = JSON.parse((await invoke(route)).body)
  assert.deepEqual(snapshot.connections.find(item => item.id === connected.id)?.workbench?.visibleSchemas, ['app', 'hr'])
})

test('workbench schema-only patch does not drop visibleSchemas', async t => {
  const { routes } = fixture(t)
  const route = routes.get('/plugins/database/connections')
  const connected = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'connect', input: connectInput } })).body)
  await invoke(route, { method: 'POST', body: { action: 'workbench', id: connected.id, workbench: { visibleSchemas: ['app', 'hr'] } } })
  const saved = JSON.parse((await invoke(route, {
    method: 'POST',
    body: { action: 'workbench', id: connected.id, workbench: { schema: 'app' } },
  })).body)
  assert.deepEqual(saved.workbench.visibleSchemas, ['app', 'hr'])
  assert.equal(saved.workbench.schema, 'app')
})

test('database API prefers structured connection codes over message inference', async t => {
  const { routes } = fixture(t)
  const route = routes.get('/plugins/database/connections')
  const connected = JSON.parse((await invoke(route, { method: 'POST', body: { action: 'connect', input: connectInput } })).body)
  const response = await invoke(route, {
    method: 'POST',
    body: {
      action: 'manual-query',
      id: connected.id,
      generation: connected.generation,
      input: { schema: 'app', sql: 'SELECT STRUCTURED_BUSY' },
    },
  })
  assert.equal(response.status, 400)
  assert.deepEqual(JSON.parse(response.body), { error: '文案不包含分类关键字', code: 'connection_busy' })
})

test('database registration failure is isolated and still disposable', async () => {
  const registration = tryRegisterDatabase({
    sessions: { get: () => ({}) },
    connection: { requestRejection: () => undefined },
    webServer: { register() { throw new Error('webServer unavailable') } },
    tools: { register() {} },
    on() { return () => {} },
  }, workerUrl)
  await registration.dispose()
})

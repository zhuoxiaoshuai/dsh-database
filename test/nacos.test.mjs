import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Worker } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { nacosEndpoint } from '../src/shared/data-sources/nacos-endpoints.mjs'
import { NacosHttpClient } from '../src/host/data-sources/nacos/http-client.mjs'
import { nacosModule } from '../src/host/data-sources/nacos/module.ts'
import { canReuseSavedLogin, passwordRequired, validateConnection } from '../src/shared/connection-input.ts'

const base = { name: '', dialect: 'nacos', host: '127.0.0.1', port: 8848, database: '', oracleMode: 'service', username: '', password: '', environment: 'sit' }

test('Nacos connection allows an empty account and rejects a password without a username', async () => {
  const open = nacosModule.connection.validate(base)
  assert.equal(open.dialect, 'nacos')
  assert.equal(open.port, 8848)
  assert.equal(open.username, '')
  assert.equal(open.password, '')
  assert.equal(open.name, 'Nacos · 127.0.0.1:8848')
  assert.equal(passwordRequired('nacos'), false)
  assert.equal(canReuseSavedLogin({ dialect: 'nacos', hasPassword: false }), true)
  const named = nacosModule.connection.validate({ ...base, database: 'team-a', username: 'nacos', password: 'secret' })
  assert.equal(named.database, 'team-a')
  assert.equal(nacosModule.connection.fingerprint(named), nacosModule.connection.fingerprint({ ...named, password: 'other' }))
  assert.equal(nacosModule.connection.fingerprint(named), nacosModule.connection.fingerprint({ ...named, database: '' }))
  assert.throws(() => nacosModule.connection.validate({ ...base, password: 'secret' }), /请填写用户名/)
  assert.throws(() => validateConnection({ ...base, dialect: 'kafka' }), /请选择 MySQL、Oracle、Redis 或 Nacos/)
  assert.equal('brokers' in nacosModule.connection.validate({ ...base, brokers: ['127.0.0.1:8848'] }), false)
  assert.throws(() => nacosModule.connection.validate({ ...base, database: 'bad\nspace' }), /命名空间无效/)
  const stored = nacosModule.connection.normalizeStoredSettings({ ...open, password: 'x' })
  assert.equal(stored.password, undefined)
  assert.equal(stored.dialect, 'nacos')
  assert.equal(nacosModule.explorer, undefined)
  assert.equal(nacosModule.execution, undefined)
})

test('Nacos endpoint defaults and custom protocol/path are validated', () => {
  assert.equal(nacosEndpoint({host:'nacos.internal',port:8848}), 'http://nacos.internal:8848/nacos')
  assert.equal(nacosEndpoint({host:'[::1]',port:443,protocol:'https',contextPath:'/custom/nacos'}), 'https://[::1]:443/custom/nacos')
  assert.throws(() => nacosEndpoint({host:'http://evil',port:8848}), /主机/)
  assert.doesNotMatch(readFileSync(new URL('../src/shared/data-sources/nacos.ts', import.meta.url), 'utf8'), /from ['"](?:node:|\.\.\/\.\.\/host)/)
})

test('production Nacos HTTP client handles health and login without exposing credentials', async () => {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body instanceof URLSearchParams ? init.body.toString() : '' })
    if (init.method === 'GET') return { ok: true, status: 200, text: async () => 'OK', json: async () => ({}) }
    return { ok: true, status: 200, text: async () => JSON.stringify({accessToken:'token-1'}), json: async () => ({ accessToken: 'token-1' }) }
  }
  const health = new NacosHttpClient({ host: '127.0.0.1', port: 8848, username: '', password: '', database: 'public' }, { fetch });await health.request('/v1/console/health/liveness',{text:true})
  assert.equal(health.token, '')
  assert.equal(health.input.database, 'public')
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].url, 'http://127.0.0.1:8848/nacos/v1/console/health/liveness')
  const login = new NacosHttpClient({ host: '127.0.0.1', port: 8848, username: 'nacos', password: 'secret' }, { fetch });await login.login()
  assert.equal(login.token, 'token-1')
  assert.equal(calls[1].method, 'POST')
  assert.equal(calls[1].body, 'username=nacos&password=secret')
  assert.equal(calls[1].url.includes('secret'), false)
  const denied = async (url, init) => ({ ok: false, status: 403, text: async () => `denied secret ${init.body}`, json: async () => ({}) })
  await assert.rejects(new NacosHttpClient({ host: '127.0.0.1', port: 8848, username: 'nacos', password: 'secret' }, { fetch: denied }).login(), error => {
    assert.match(error.message, /登录失败/)
    assert.equal(error.message.includes('secret'), false)
    return true
  })
})

test('production Nacos HTTP client reports timeout without hanging', async () => {
  const fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  })
  const begun = Date.now()
  await assert.rejects(new NacosHttpClient(base, { fetch, timeoutMs: 30 }).request('/v1/console/health/liveness',{text:true}), /超时/)
  assert.ok(Date.now() - begun < 1000)
})

function listen(handler) {
  const server = createServer(handler)
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function openWorker(input, testOnly = false) {
  const worker = new Worker(new URL('../src/host/nacos-worker.mjs', import.meta.url))
  const ready = new Promise((resolve, reject) => {
    const finish = message => (message.ready || message.ok) ? resolve(message) : reject(new Error(message.error || '连接失败。'))
    worker.once('message', finish)
    worker.once('error', reject)
  })
  worker.postMessage({ input, testOnly })
  return { worker, ready }
}

test('Nacos worker health, login and rejected login do not echo the password', async () => {
  let loginBody = ''
  const healthServer = await listen((request, response) => {
    assert.equal(request.method, 'GET')
    assert.equal(request.url, '/nacos/v1/console/health/liveness')
    response.end('OK')
  })
  const healthPort = healthServer.address().port
  const health = openWorker({ ...base, port: healthPort })
  try {
    const message = await health.ready
    assert.equal(message.result.version, '2.4.3 API')
    assert.equal(message.result.database, '')
    assert.equal(JSON.stringify(message).includes('password'), false)
  } finally {
    await health.worker.terminate()
    healthServer.close()
  }

  const loginServer = await listen((request, response) => {
    if (request.method === 'GET') {
      const url = new URL(request.url, 'http://127.0.0.1')
      assert.equal(url.pathname, '/nacos/v1/console/health/liveness')
      assert.equal(url.searchParams.get('accessToken'), 'token-1')
      response.end('OK')
      return
    }
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      loginBody = Buffer.concat(chunks).toString()
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ accessToken: 'token-1' }))
    })
  })
  const login = openWorker({ ...base, port: loginServer.address().port, username: 'nacos', password: 'secret' })
  try {
    const message = await login.ready
    assert.equal(message.result.health, 'ready')
    assert.equal(loginBody, 'username=nacos&password=secret')
    assert.equal(JSON.stringify(message).includes('secret'), false)
    assert.equal(JSON.stringify(message).includes('token-1'), false)
    const checked = new Promise((resolve, reject) => {
      login.worker.once('message', reply => reply.error ? reject(new Error(reply.error)) : resolve(reply))
    })
    login.worker.postMessage({ requestId: 'health', action: 'nacos-health' })
    const reply = await checked
    assert.equal(reply.result.ok, true)
    assert.equal(JSON.stringify(reply).includes('token-1'), false)
  } finally {
    await login.worker.terminate()
    loginServer.close()
  }

  const deniedServer = await listen((request, response) => {
    response.writeHead(401, { 'content-type': 'text/plain' })
    response.end('bad secret')
  })
  const denied = openWorker({ ...base, port: deniedServer.address().port, username: 'nacos', password: 'secret' })
  try {
    await assert.rejects(denied.ready, error => {
      assert.match(error.message, /登录失败/)
      assert.equal(error.message.includes('secret'), false)
      return true
    })
  } finally {
    await denied.worker.terminate()
    deniedServer.close()
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startStandalone, standalonePort, standaloneRoot } from '../src/serve.ts'
import { detectDshProfiles, installDshPlugin, parseLaunchArgs, resolvePluginTarball, runLaunch } from '../src/launch.ts'
import { connectionInput, temporaryDirectory } from './helpers.mjs'

const workerUrl = pathToFileURL(join(process.cwd(), 'test/fixtures/database-worker.mjs'))

test('Windows installer preserves tarball paths through a real cmd shim', { skip: process.platform !== 'win32' }, t => {
  const directory = temporaryDirectory(t, 'launch-args-')
  const recorder = join(directory, 'record.cjs')
  writeFileSync(recorder, 'console.log(JSON.stringify(process.argv.slice(2)))')
  writeFileSync(join(directory, 'dsh.cmd'), `@"${process.execPath}" "${recorder}" %*\r\n`)
  const launchUrl = new URL('../src/launch.ts', import.meta.url).href
  for (const tarball of [join(directory, '中文 空格', 'dsh-database.tgz'), join(directory, '100% & ! ^ (安装)', 'dsh-database.tgz')]) {
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
      `import {installDshPlugin} from ${JSON.stringify(launchUrl)}; await installDshPlugin(['web','desktop'], process.env.TEST_INSTALL_TGZ)`],
      { encoding: 'utf8', windowsHide: true, env: { ...process.env, PATH: `${directory};${process.env.PATH}`, TEST_INSTALL_TGZ: tarball } })
    assert.equal(child.status, 0, child.stderr || child.error?.message)
    const received = child.stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
    assert.deepEqual(received, ['web', 'desktop'].map(profile => ['plugin', '--profile', profile, 'add', tarball]))
  }
})

test('installer rejects paths that can break command quoting', async () => {
  for (const tarball of ['bad"path.tgz', 'bad\npath.tgz', 'bad\0path.tgz']) await assert.rejects(installDshPlugin(['web'], tarball), /路径无效/)
})

function request(port, { method = 'GET', path = '/', host, cookie, origin, body } = {}) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        host: host ?? `127.0.0.1:${port}`,
        ...(cookie ? { cookie } : {}),
        ...(origin ? { origin } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

function cookiePair(headers) {
  const raw = headers['set-cookie']
  const line = Array.isArray(raw) ? raw[0] : raw
  assert.equal(typeof line, 'string')
  return line.split(';')[0]
}

test('standalone root ignores DSH_HOME and rejects a bad PORT', () => {
  assert.equal(standaloneRoot({ DSH_HOME: 'C:/dsh', DSH_DATABASE_HOME: 'C:/isolated' }, 'C:/home'), 'C:/isolated')
  assert.equal(standaloneRoot({ DSH_HOME: 'C:/dsh' }, 'C:/home'), join('C:/home', '.dsh-database'))
  assert.equal(standalonePort({}), 17890)
  assert.throws(() => standalonePort({ PORT: 'nope' }), /PORT 无效/)
})

test('standalone page is loopback-only and stores connections outside DSH', async t => {
  const directory = temporaryDirectory(t, 'standalone-')
  const dshHome = join(directory, 'dsh-home')
  const root = join(directory, 'workbench')
  const assets = join(directory, 'assets')
  mkdirSync(dshHome)
  mkdirSync(assets)
  writeFileSync(join(assets, 'index.html'), '<title>数据库工作台</title>')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  const started = await startStandalone({ port: 0, root, assetsDir: assets, workerUrl })
  t.after(async () => {
    await started.close()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  })
  const wrongHost = await request(started.port, { host: 'evil.example' })
  assert.equal(wrongHost.status, 403)
  const page = await request(started.port)
  assert.equal(page.status, 200)
  assert.match(page.body, /数据库工作台/)
  const cookie = cookiePair(page.headers)
  const anonymous = await request(started.port, { path: '/api/database/connections' })
  assert.equal(anonymous.status, 403)
  const origin = `http://127.0.0.1:${started.port}`
  const crossSite = await request(started.port, {
    method: 'POST', path: '/api/database/connections', cookie, origin: 'http://evil.example', body: { action: 'execution-list' },
  })
  assert.equal(crossSite.status, 403)
  const snapshot = await request(started.port, { path: '/api/database/connections', cookie })
  assert.equal(snapshot.status, 200)
  assert.deepEqual(JSON.parse(snapshot.body).connections, [])
  const connected = await request(started.port, {
    method: 'POST', path: '/api/database/connections', cookie, origin, body: { action: 'connect', input: connectionInput() },
  })
  assert.equal(connected.status, 200)
  assert.equal(typeof JSON.parse(connected.body).id, 'string')
  assert.equal(existsSync(join(root, 'database-workspace.json')), true)
  assert.equal(existsSync(join(dshHome, 'database')), false)
  assert.equal(existsSync(join(dshHome, 'database', 'database-workspace.json')), false)
})

test('launch arguments reject unknown flags', () => {
  assert.deepEqual(parseLaunchArgs(['--standalone']), { standalone: true })
  assert.deepEqual(parseLaunchArgs([]), { standalone: false })
  assert.throws(() => parseLaunchArgs(['--serve']), /未知参数/)
})

test('DSH profile detection only sees the three known manifests', () => {
  const home = 'C:/Users/tester'
  const env = { APPDATA: 'C:/AppData/Roaming' }
  const desktopWeb = join(env.APPDATA, 'dsh-desktop', 'harness', 'profiles', 'web', 'package.json')
  const cliDesktop = join(home, '.dsh', 'profiles', 'desktop', 'package.json')
  assert.deepEqual(detectDshProfiles({ env, home, exists: () => false }), [])
  assert.deepEqual(detectDshProfiles({ env, home, exists: path => path === desktopWeb || path === cliDesktop }), ['web', 'desktop'])
})

test('launch installs into DSH when a profile exists and does not listen', async () => {
  const home = 'C:/Users/tester'
  const env = { APPDATA: '' }
  let installed
  let listened = false
  const result = await runLaunch({
    args: [],
    env,
    home,
    exists: path => path === join(home, '.dsh', 'profiles', 'web', 'package.json'),
    resolveTarball: () => 'dsh-database.tgz',
    installPlugin: async (profiles, tarball) => { installed = { profiles, tarball } },
    start: async () => { listened = true; throw new Error('should not listen') },
    openBrowser: () => { throw new Error('should not open a browser') },
    log: () => {},
  })
  assert.equal(result.mode, 'plugin')
  assert.equal(listened, false)
  assert.deepEqual(installed, { profiles: ['web'], tarball: 'dsh-database.tgz' })
})

test('--standalone skips DSH install even when a profile exists', async () => {
  let installed = false
  let opened
  let logged
  const result = await runLaunch({
    args: ['--standalone'],
    exists: () => true,
    installPlugin: async () => { installed = true },
    start: async () => ({ url: 'http://127.0.0.1:17890/', root: 'unused', port: 17890, server: {}, close: async () => {} }),
    openBrowser: url => { opened = url },
    log: message => { logged = message },
  })
  assert.equal(installed, false)
  assert.equal(result.mode, 'standalone')
  assert.equal(opened, 'http://127.0.0.1:17890/')
  assert.equal(logged, '访问地址：http://127.0.0.1:17890/')
})

test('plugin tarball resolution stays inside the given directories', t => {
  const directory = temporaryDirectory(t, 'standalone-tgz-')
  writeFileSync(join(directory, 'dsh-database-0.0.0.tgz'), '')
  assert.equal(resolvePluginTarball({}, [directory]), join(directory, 'dsh-database-0.0.0.tgz'))
  assert.equal(resolvePluginTarball({ DSH_DATABASE_TGZ: 'C:/explicit.tgz' }, [directory]), 'C:/explicit.tgz')
  assert.throws(() => resolvePluginTarball({}, [join(directory, 'missing')]), /未找到 dsh-database 安装包/)
})

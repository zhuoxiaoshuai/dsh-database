import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

const receipt = JSON.parse(await readFile(resolve('../plugin-installer/.pack/state/latest.json'), 'utf8'))
const item = receipt.packages.find(p => p.id === 'database')
assert.ok(item?.exe)
const root = resolve('artifacts/standalone-package-acceptance', randomUUID())
await mkdir(root, { recursive: true })
// Keep the executable/cache outside the checkout: Node must not find the
// development node_modules by walking parent directories.
const isolated = join(tmpdir(), `dsh-standalone 中文 ${randomUUID()}`)
if (!resolve(isolated).startsWith(resolve(tmpdir()) + sep) || resolve(isolated).startsWith(resolve('.') + sep)) throw new Error('Standalone acceptance requires its own directory outside the checkout')
await mkdir(isolated)
const exe = join(isolated, 'database.exe')
await copyFile(item.exe.path, exe)
const preload = join(isolated, 'headless.cjs'), calls = join(isolated, 'child-calls.jsonl')
await writeFile(preload, `const cp=require('node:child_process'),fs=require('node:fs'),{syncBuiltinESMExports}=require('node:module');const original=cp.spawn;cp.spawn=function(file,args,options){fs.appendFileSync(process.env.ACCEPT_CALLS,JSON.stringify({file,args})+${JSON.stringify('\n')});if(/npm|pnpm/i.test(file))throw Error('Package manager invoked during standalone');if(file==='cmd.exe'&&args[1]==='start')return {unref(){return this}};return original.call(this,file,args,options)};syncBuiltinESMExports();\n`)
const cache = join(isolated, '中文 cache'), env = { ...process.env, NODE_PATH: '', PORT: '0', DSH_DATABASE_HOME: join(isolated, 'data'), DSH_STANDALONE_CACHE: cache, ACCEPT_CALLS: calls, NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"`, npm_config_registry: 'http://127.0.0.1:1', npm_config_offline: 'true' }
const results = []
async function stop(child) {
  if (child.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))])
}
async function launch(label) {
  const start = Date.now(), child = spawn(exe, ['--standalone'], { cwd: isolated, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  const url = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { void stop(child); reject(new Error(`${label} timed out: ${stdout}\n${stderr}`)) }, 120000)
    child.stdout.on('data', bytes => { stdout += bytes; const found = stdout.match(/http:\/\/127\.0\.0\.1:\d+\//); if (found) { clearTimeout(timer); resolvePromise(found[0]) } })
    child.stderr.on('data', bytes => { stderr += bytes })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`${label} exited ${code}: ${stdout}\n${stderr}`)) })
  })
  return { child, url, stdout: () => stdout, stderr: () => stderr, milliseconds: Date.now() - start }
}
let browser
try {
  for (const label of ['cold', 'warm', 'reset']) {
    if (label === 'warm') {
      const dirs = await readdir(cache)
      await writeFile(join(cache, dirs[0], 'package/.runtime-verify.cjs'), "throw new Error('Runtime verifier must not run during launch')")
      await writeFile(join(cache, dirs[0], 'package/.runtime-manifest.json'), '{"nodeMajor":999,"files":[]}')
    }
    if (label === 'reset') { const dirs = await readdir(cache); await rm(join(cache, dirs[0], '.payload-stamp')) }
    const run = await launch(label)
    try {
      const response = await fetch(run.url)
      assert.equal(response.status, 200)
      const cookie = response.headers.get('set-cookie').split(';')[0]
      assert.match(await response.text(), /preview\.js/)
      assert.equal((await fetch(run.url + 'preview.js')).status, 200)
      assert.equal((await fetch(run.url + 'preview.css')).status, 200)
      assert.equal((await fetch(run.url + 'api/database/connections')).status, 403)
      assert.equal((await fetch(run.url + 'api/database/connections', { headers: { cookie } })).status, 200)
      if (label !== 'warm') assert.match(run.stdout(), /正在准备/)
      else assert.doesNotMatch(run.stdout(), /正在准备|正在展开|正在安装/)
      if (label === 'cold') {
        browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
        const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
        const errors = []; page.on('pageerror', e => errors.push(e.message))
        const external = []; await page.route('**/*', route => { if (route.request().url().startsWith(run.url)) return route.continue(); external.push(route.request().url()); return route.abort() })
        await page.goto(run.url)
        await page.locator('.db-workbench').waitFor({ state: 'visible', timeout: 15000 })
        const body = await page.locator('body').innerText()
        assert.match(body, /连接|数据库/)
        await page.getByRole('button', { name: '添加连接', exact: true }).click()
        for (const source of ['MySQL', 'Oracle', 'Redis', 'Kafka', 'Nacos']) assert.ok((await page.locator('body').innerText()).includes(source), `Missing ${source} entry`)
        await page.screenshot({ path: join(root, 'standalone-1200.png') })
        assert.deepEqual(errors, [])
        assert.deepEqual(external, [])
        await browser.close(); browser = undefined
      }
      results.push({ label, status: 'PASS', milliseconds: run.milliseconds, url: run.url, stdout: run.stdout(), stderr: run.stderr() })
    } finally { await stop(run.child) }
  }
  const dirs = await readdir(cache), packageDir = join(cache, dirs[0], 'package')
  const inventory = JSON.parse(await readFile(join(packageDir, '.runtime-manifest.json'), 'utf8'))
  assert.ok(inventory.dependencies.includes('mysql2') && inventory.dependencies.includes('oracledb') && inventory.dependencies.includes('redis') && inventory.dependencies.includes('kafkajs'))
  assert.equal((await stat(join(packageDir, 'lib/connection-worker.mjs'))).isFile(), true)
  const spawned = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(spawned.filter(call => /npm|pnpm/i.test(call.file)).length, 0)
  console.log(JSON.stringify({ status: 'PASS', root, exeBytes: item.exe.bytes, results, spawned }, null, 2))
  await writeFile(join(root, 'result.json'), JSON.stringify({ status: 'PASS', root, isolated, results, spawned }, null, 2))
} finally { if (browser) await browser.close(); await rm(isolated, { recursive: true, force: true }) }

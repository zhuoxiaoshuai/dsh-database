/** Boot the installed Harness with a disposable profile, never the user's profile. */
import { mkdir, mkdtemp, writeFile, readFile, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { installedBusiness } from './installed-business.mjs'
import { installedRedis } from './installed-redis.mjs'
import { installedKafka } from './installed-kafka.mjs'
import { dismissHarnessOnboarding } from './harness-onboarding.mjs'

const desktop = process.env.DSH_DESKTOP_APP || ''
const electronRuntime = Boolean(desktop) && existsSync(join(desktop, 'DeepSeek Harness.exe')) && existsSync(join(desktop, 'resources/app.asar'))
const node = desktop ? (electronRuntime ? join(desktop, 'DeepSeek Harness.exe') : join(desktop, 'node_modules/node/bin/node.exe')) : ''
const cli = desktop ? (electronRuntime ? join(desktop, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js') : join(desktop, 'node_modules/@deepseek-ai/dsh/lib/bin.js')) : ''
const runtimeArguments = electronRuntime ? ['--expose-internals'] : []
const runtimeEnvironment = electronRuntime ? { ELECTRON_RUN_AS_NODE: '1' } : {}
await mkdir('artifacts/host', { recursive: true })
const run = await mkdtemp(resolve('artifacts/host/run-')), profile = join(run, 'profiles/web'), work = join(run, 'work')
if (!existsSync(node) || (!electronRuntime && !existsSync(cli))) {
  const report = { status: 'NOT_RUN', stage: 'environment', run, installedHarness: 'NOT_RUN',
    reason: 'DSH 安装目录中缺少 Node 或 Harness CLI；请通过 DSH_DESKTOP_APP 指定当前安装根目录或旧 app／app.asar.unpacked 目录。',
    databaseExecution: 'NOT_RUN', realDatabase: 'NOT_RUN', liveDesktopRestart: 'NOT_RUN', checks: [] }
  await writeFile(join(run, 'report.json'), JSON.stringify(report, null, 2))
  await writeFile(resolve('artifacts/host/latest.json'), JSON.stringify(report, null, 2))
  throw new Error(report.reason)
}
await mkdir(work); await mkdir(join(run, 'storages'))
async function command(executable, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, executable === node ? [...runtimeArguments, ...args] : args, { cwd, env: executable === node ? { ...env, ...runtimeEnvironment } : env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Package operation timed out')) }, 180000)
    child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output.slice(-6000))) })
  })
}
const npmCli = resolve(process.execPath, '..', 'node_modules/npm/bin/npm-cli.js')
const packOutput = await command(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', run], process.cwd(), process.env)
const jsonStart = Math.max(packOutput.lastIndexOf('\n['), packOutput.startsWith('[') ? 0 : -1)
if (jsonStart < 0) throw new Error(`npm pack did not return JSON: ${packOutput.slice(-1000)}`)
const [packed] = JSON.parse(packOutput.slice(jsonStart).trim())
for (const file of packed.files) assert.ok(/^(package\.json|README(?:\.zh)?\.md|LICENSE|cordis\.patch\.yml|lib\/(index\.js|client\.js|[a-z-]+\.mjs|dialects\/[a-z-]+\.mjs|shared\/[a-z-]+\.mjs|data-sources\/(?:[a-z-]+\/)*[a-z-]+\.mjs))$/.test(file.path), `Unexpected release file: ${file.path}`)
const tarball = join(run, packed.filename)
await mkdir(profile, { recursive: true })
// Thin mode uses pure JS; explicitly decline the driver's optional native installation check.
// pnpm 11 otherwise exits before the Harness CLI can register the bundle.
await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  oracledb: false\n')
if (process.env.DSH_TEST_ALLOW_VERSION) {
  await command(node, [cli, 'plugin', '--profile', 'web', 'allow-version', `${packed.name}@${packed.version}`, '--dsh-version', process.env.DSH_TEST_ALLOW_VERSION, '--accept-risk'], work, { ...process.env, DSH_HOME: run, DSH_TELEMETRY_DISABLED: '1' })
}
await writeFile(join(run, 'install.log'), await command(node, [cli, 'plugin', '--profile', 'web', 'add', tarball], work, { ...process.env, DSH_HOME: run, DSH_TELEMETRY_DISABLED: '1' }))
const installedPath = await realpath(join(profile, 'node_modules/dsh-database'))
assert.ok(installedPath.startsWith(profile), 'Plugin must resolve inside the installed profile, never the source checkout')
const timestamp = new Date().toISOString()
await writeFile(join(run, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: ['database-acceptance'], archivedSessionIds: [] }, tables: { workspaces: { 'database-acceptance': { path: work, title: 'Database M0 验证', sessionIds: [], createdAt: timestamp, updatedAt: timestamp } } } }))
assert.ok(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')).dsh.profile.bundles.includes('dsh-database'), 'CLI must register the plugin bundle')
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve))
const child = spawn(node, [...runtimeArguments, cli, 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)], { cwd: work, windowsHide: true, env: { ...process.env, ...runtimeEnvironment, DSH_HOME: run, DSH_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
let log = '', failure, browser, page, stage = 'boot host'
const pageErrors = [], consoleErrors = [], serverErrors = []
child.stdout.on('data', chunk => { log += chunk }); child.stderr.on('data', chunk => { log += chunk }); child.on('error', error => { failure = error })
const desktopManifest = await readFile(join(desktop, 'package.json'), 'utf8').then(JSON.parse).catch(() => null)
const installedHarness = electronRuntime ? (await command(node, [cli, '--version'], work, { ...process.env, DSH_HOME: run, DSH_TELEMETRY_DISABLED: '1' })).trim() : JSON.parse(await readFile(join(desktop, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version
const report = { status: 'RUNNING', installedDesktop: desktopManifest?.version || (electronRuntime ? 'ASAR_NODE_RUNTIME' : 'NOT_AVAILABLE_ASAR'), installedHarness, databaseExecution: 'ALPHA_CONTROLLED_MAINTENANCE_UNVERIFIED', realDatabase: 'NOT_RUN', liveDesktopRestart: 'NOT_RUN', checks: [] }
try {
  let url
  const deadline = Date.now() + 55000
  while (Date.now() < deadline) {
    if (failure) throw failure
    assert.equal(child.exitCode, null, 'isolated Harness exited before ready')
    url = log.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/)?.[1]
    if (url) break
    await delay(250)
  }
  assert.ok(url, 'Harness URL not emitted')
  const origin = new URL(url).origin
  const unauthorized = await fetch(`${origin}/plugins/database/status?conversationId=unknown`)
  assert.equal(unauthorized.status, 401)
  report.checks.push('Uncredentialed plugin HTTP request rejected by real host authentication')
  browser = await chromium.launch({ channel: process.env.DSH_TEST_BROWSER || 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 } })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('response', response => { if (response.status() >= 500 && new URL(response.url()).pathname.startsWith('/plugins/database/')) serverErrors.push(`${response.status()} ${new URL(response.url()).pathname}`) })
  stage = 'open workspace'
  await page.goto(url)
  const entries = page.getByRole('button', { name: '打开数据库工作台', exact: true })
  await dismissHarnessOnboarding(page)
  await entries.first().waitFor({ timeout: 5000 }).catch(() => {})
  if (!await entries.count()) {
    await page.getByRole('button', { name: '选择工作区', exact: true }).click()
    await page.getByText('Database M0 验证', { exact: true }).last().click()
  }
  stage = 'mount conversation sidebar'
  const savedSession = page.getByText('新会话', { exact: true }).last()
  if (await savedSession.count()) await savedSession.click()
  const mountedSidebar = page.locator('[data-sidebar-right-session]:not([hidden])').first()
  await mountedSidebar.waitFor({ state: 'attached', timeout: 20000 })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  stage = 'open database sidebar'
  await entries.first().waitFor({ timeout: 20000 }); await entries.first().click()
  const panel = page.getByText('选择或添加数据库连接', { exact: true })
  await panel.waitFor({ timeout: 15000 })
  report.checks.push('Database tab opens from a mounted DSH conversation')
  await page.screenshot({ path: join(run, 'host-workbench.png') })
  assert.equal(await page.getByText('ORD-20260912-0081', { exact: true }).count(), 0)
  report.checks.push('Real Loader mounted host and client; no fixture data in real DSH surface')
  const sessionId = await panel.locator('xpath=ancestor-or-self::*[@data-conversation][1]').getAttribute('data-conversation')
  assert.ok(sessionId)
  const reply = await page.evaluate(async sessionId => { const response = await fetch('/plugins/database/status?conversationId=' + encodeURIComponent(sessionId)); return { status: response.status, body: await response.json() } }, sessionId)
  assert.equal(reply.status, 200); assert.equal(reply.body.executionEnabled, true)
  const nonexistent = await page.evaluate(async () => (await fetch('/plugins/database/status?conversationId=missing')).status)
  assert.equal(nonexistent, 404)
  report.checks.push('Authenticated browser status bound to a real host session; unknown session denied')
  assert.equal((await fetch(`${origin}/plugins/database/connections?conversationId=${encodeURIComponent(sessionId)}`)).status, 401)
  const connectionApiChecks = await page.evaluate(async sessionId => {
    const endpoint = '/plugins/database/connections?conversationId=' + encodeURIComponent(sessionId)
    const list = await fetch(endpoint)
    const invalid = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'test', input: {} }) })
    const missing = await fetch('/plugins/database/connections?conversationId=missing')
    return { list: list.status, body: await list.json(), invalid: invalid.status, missing: missing.status }
  }, sessionId)
  assert.equal(connectionApiChecks.list, 200)
  assert.deepEqual(connectionApiChecks.body.connections, [])
  assert.equal(connectionApiChecks.invalid, 400)
  assert.equal(connectionApiChecks.missing, 200)
  report.checks.push('Real host connection API enforces authentication and rejects invalid connection input; workbench accepts listed conversation ids that are not yet live')
  const executionList = await page.evaluate(async sessionId => {
    const response = await fetch('/plugins/database/connections?conversationId=' + encodeURIComponent(sessionId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'execution-list' }) })
    return { status: response.status, body: await response.json() }
  }, sessionId)
  assert.equal(executionList.status, 200)
  assert.ok(Array.isArray(executionList.body.items))
  report.checks.push('Authenticated execution-list is conversation-scoped; live AI tool/callId correlation remains NOT_RUN')
  await entries.first().click()
  if (await panel.isVisible()) {
    report.checks.push('Database workbench entry remains idempotent in real DSH')
  } else {
    await entries.first().click(); await panel.waitFor()
    report.checks.push('Panel closes and reopens inside real DSH')
  }
  if (process.env.DSH_TEST_DATABASES === '1') {
    for (const dialect of ['mysql', 'oracle']) report.checks.push(await installedBusiness(page, sessionId, dialect, run))
    report.realDatabase = process.env.DSH_TEST_EXISTING_ENV === '1'
      ? 'Existing local MySQL and Oracle 19c test instances: installed plugin read and controlled DML/DDL in isolated run namespaces; SID NOT_RUN'
      : 'MySQL 8.4.5 and Oracle Free 23 (19c NOT_RUN): installed plugin read and controlled DML/DDL acceptance'
    report.databaseExecution = process.env.DSH_TEST_EXISTING_ENV === '1' ? 'EXISTING_TEST_NAMESPACE_DML_DDL_VERIFIED' : 'DISPOSABLE_FIXTURE_DML_DDL_VERIFIED'
  }
  if (process.env.DSH_TEST_REDIS === '1') report.checks.push(await installedRedis(page, sessionId))
  if (process.env.DSH_TEST_KAFKA === '1') report.checks.push(await installedKafka(page, sessionId))
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(serverErrors, [])
  report.checks.push('No browser page errors')
  report.status = 'PASS'
} catch (error) {
  report.status = 'FAIL'; report.error = error.message; report.stage = error.acceptanceStage || stage
  report.diagnostics = {
    ...(error.acceptanceDebug ? { acceptanceDebug: error.acceptanceDebug } : {}),
    entryCount: page ? await page.getByRole('button', { name: '打开数据库工作台', exact: true }).count().catch(() => 0) : 0,
    workspaceCount: page ? await page.getByText('Database M0 验证', { exact: true }).count().catch(() => 0) : 0,
    mountedSidebarCount: page ? await page.locator('[data-sidebar-right-session]:not([hidden])').count().catch(() => 0) : 0,
    sidebarTabs: page ? await page.getByRole('tab').allTextContents().then(items => items.map(value => value.trim()).filter(Boolean).slice(0, 12)).catch(() => []) : [],
    pageErrors: pageErrors.slice(0, 5).map(value => value.replace(/token=[^\s"']+/g, 'token=[REDACTED]').slice(0, 250)),
    consoleErrors: consoleErrors.slice(0, 5).map(value => value.replace(/token=[^\s"']+/g, 'token=[REDACTED]').slice(0, 250)),
    serverErrors: serverErrors.slice(0, 5),
  }
  await page?.screenshot({ path: join(run, 'failure.png') }).catch(() => {})
  if (page) await writeFile(join(run, 'page.txt'), await page.locator('body').innerText().catch(() => 'unavailable'))
  process.exitCode = 1
} finally {
  await browser?.close()
  child.kill()
  await writeFile(join(run, 'boot.log'), log.replace(/token=[^\s"']+/g, 'token=[REDACTED]'))
  await writeFile(join(run, 'report.json'), JSON.stringify(report, null, 2))
  await writeFile('artifacts/host/latest.json', JSON.stringify({ run, ...report }, null, 2))
  console.log(JSON.stringify({ run, ...report }, null, 2))
}

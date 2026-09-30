import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'

// Continue only a previously created isolated acceptance home, never the user's profile.
const prior = JSON.parse(await readFile('artifacts/host/latest.json', 'utf8'))
const run = resolve(prior.run), root = resolve('artifacts/host')
assert.ok(run.startsWith(root + '\\') && /run-[\w-]+$/.test(run))
assert.equal(prior.status, 'PASS')
const profile = join(run, 'profiles/web'), work = join(run, 'work')
const desktop = process.env.DSH_DESKTOP_APP
if (!desktop) throw new Error('请设置 DSH_DESKTOP_APP 为 DSH Desktop 安装目录。')
const node = join(desktop, 'node_modules/node/bin/node.exe'), cli = join(desktop, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const env = { ...process.env, DSH_HOME: run, DSH_TELEMETRY_DISABLED: '1' }
async function command(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Lifecycle package operation timed out')) }, 180000)
    child.stdout.on('data', c => { output += c }); child.stderr.on('data', c => { output += c })
    child.on('error', e => { clearTimeout(timer); reject(e) }); child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output.slice(-3000))) })
  })
}
const backup = join(run, 'lifecycle-backup'), stage = join(run, 'upgrade-package')
await mkdir(backup, { recursive: true }); await mkdir(stage, { recursive: true })
const packageJson = JSON.parse(await readFile(join(profile, 'node_modules/dsh-database/package.json'), 'utf8'))
const oldPackage = join(run, `${packageJson.name}-${packageJson.version}.tgz`)
await cp(oldPackage, join(backup, 'previous.tgz'))
const saved = []
for (const file of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
  try { await cp(join(profile, file), join(backup, file)); saved.push(file) } catch (e) { if (e.code !== 'ENOENT') throw e }
}
for (const file of packageJson.files) { await mkdir(join(stage, file, '..'), { recursive: true }); await cp(join(profile, 'node_modules/dsh-database', file), join(stage, file)) }
packageJson.version += '.upgrade-test'
await writeFile(join(stage, 'package.json'), JSON.stringify(packageJson, null, 2))
const npmCli = resolve(process.execPath, '..', 'node_modules/npm/bin/npm-cli.js')
const [packed] = JSON.parse(await command(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', run], stage))
const report = { status: 'RUNNING', scope: 'Isolated CLI lifecycle and real host routing; database and current Desktop coexistence NOT_RUN', run, checks: [] }
async function boot(expectedStatus) {
  const reservation = createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r)); const port = reservation.address().port; await new Promise(r => reservation.close(r))
  const child = spawn(node, [cli, 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)], { cwd: work, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; child.stdout.on('data', c => { log += c }); child.stderr.on('data', c => { log += c })
  const closed = new Promise(r => child.once('close', r))
  try {
    const deadline = Date.now() + 55000
    while (!log.includes('dsh web: http://') && Date.now() < deadline) { assert.equal(child.exitCode, null, 'Isolated host exited'); await delay(200) }
    assert.ok(log.includes('dsh web: http://'), 'Isolated host did not start')
    const response = await fetch(`http://127.0.0.1:${port}/plugins/database/status?conversationId=unknown`)
    assert.equal(response.status, expectedStatus, 'Authenticated plugin route must appear/disappear with package lifecycle')
  } finally { child.kill(); await closed }
}
try {
  await boot(401); report.checks.push('Restart installed package: authenticated database route registered')
  await command(node, [cli, 'plugin', '--profile', 'web', 'add', join(run, packed.filename)], work)
  assert.equal(JSON.parse(await readFile(join(profile, 'node_modules/dsh-database/package.json'), 'utf8')).version, packageJson.version)
  await boot(401); report.checks.push('Upgrade to a distinct local prerelease package and restart: route registered')
  await command(node, [cli, 'plugin', '--profile', 'web', 'remove', 'dsh-database'], work)
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies?.['dsh-database'], undefined)
  assert.equal(manifest.dsh.profile.bundles.includes('dsh-database'), false)
  await boot(404); report.checks.push('Uninstall through CLI: bundle removed and route absent after restart')
  for (const file of saved) await cp(join(backup, file), join(profile, file))
  await command(node, [cli, 'plugin', '--profile', 'web', 'add', oldPackage], work)
  assert.notEqual(JSON.parse(await readFile(join(profile, 'node_modules/dsh-database/package.json'), 'utf8')).version, packageJson.version)
  await boot(401); report.checks.push('Restore backed-up manifest/lock/patch and re-add the backed-up version through CLI: previous package starts')
  report.status = 'PASS'
} catch (e) { report.status = 'FAIL'; report.error = e.message; process.exitCode = 1 }
finally { await writeFile(join(run, 'lifecycle-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)) }

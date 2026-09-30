/** Pack a tarball and install that tarball into the running DSH profile. No source link, no unpack. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, realpath, rmdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const npmCli = resolve(process.execPath, '..', 'node_modules/npm/bin/npm-cli.js')
const stale = 'SASL PLAIN 必须启用 TLS'
const homes = [
  ['Desktop web', join(process.env.APPDATA || '', 'dsh-desktop', 'harness'), 'web'],
  ['CLI desktop', join(homedir(), '.dsh'), 'desktop'],
]

function run(file, args, cwd, env = process.env) {
  return new Promise((resolvePromise, reject) => {
    const command = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => { command.kill(); reject(new Error(`${file} timed out`)) }, 180000)
    command.stdout.on('data', chunk => { output += chunk })
    command.stderr.on('data', chunk => { output += chunk })
    command.on('error', error => { clearTimeout(timer); reject(error) })
    command.on('close', code => {
      clearTimeout(timer)
      code === 0 ? resolvePromise(output) : reject(new Error(`${file} ${args.join(' ')} failed (${code}): ${output.slice(-6000)}`))
    })
  })
}

function packJson(output) {
  const start = Math.max(output.lastIndexOf('\n['), output.startsWith('[') ? 0 : -1)
  if (start < 0) throw new Error(`npm pack 没有返回 JSON：${output.slice(-1000)}`)
  const [packed] = JSON.parse(output.slice(start).trim())
  if (!packed?.filename) throw new Error('npm pack 没有返回文件名。')
  return packed
}

async function profilePnpm(profileDir) {
  const modules = join(profileDir, 'node_modules', '.modules.yaml')
  if (!existsSync(modules)) throw new Error(`${profileDir} 没有 pnpm 安装记录，拒绝直接落盘。`)
  const parsed = JSON.parse(await readFile(modules, 'utf8'))
  const version = String(parsed.packageManager || '').replace(/^pnpm@/, '')
  if (!version) throw new Error(`${modules} 未记录 packageManager。`)
  let storeDir = typeof parsed.storeDir === 'string' ? parsed.storeDir.replaceAll('\\', '/') : ''
  storeDir = storeDir.replace(/\/v\d+$/, '')
  if (storeDir) {
    const npmrc = join(profileDir, '.npmrc')
    const line = `store-dir=${storeDir}`
    const current = existsSync(npmrc) ? await readFile(npmrc, 'utf8') : ''
    const next = /^store-dir=/m.test(current)
      ? current.replace(/^store-dir=[^\r\n]*/m, line)
      : `${current.trim()}${current.trim() ? '\n' : ''}${line}\n`
    if (next !== current) await writeFile(npmrc, next.endsWith('\n') ? next : `${next}\n`)
  }
  return version
}

async function unlinkSource(target, checkout) {
  if (!existsSync(target)) return
  if (await realpath(target) !== checkout) return
  try { await rmdir(target) } catch { await run(process.env.ComSpec || 'cmd.exe', ['/c', 'rmdir', target], root) }
  if (existsSync(target) && await realpath(target) === checkout) throw new Error(`请先去掉源码链接：${target}`)
}

async function assertPackage(home, profile, version, checkout, tgzMarker) {
  const installed = join(home, 'profiles', profile, 'node_modules', 'dsh-database')
  const resolved = await realpath(installed)
  if (resolved === checkout) throw new Error(`${installed} 仍指向源码。`)
  if (existsSync(join(installed, 'src'))) throw new Error(`${installed} 含源码目录，不是安装包。`)
  const pkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  if (pkg.version !== version) throw new Error(`${installed} 仍是 ${pkg.version}，期望 ${version}`)
  const lock = await readFile(join(home, 'profiles', profile, 'pnpm-lock.yaml'), 'utf8')
  if (!lock.includes(tgzMarker)) throw new Error(`${profile} 的 lockfile 未指向 ${tgzMarker}，安装包未写入。`)
  const connection = await readFile(join(installed, 'lib/data-sources/kafka/connection.mjs'), 'utf8')
  const client = await readFile(join(installed, 'lib/client.js'), 'utf8')
  if (connection.includes(stale) || client.includes(stale)) throw new Error(`${installed} 仍包含 PLAIN 强制 TLS`)
  return installed
}

const dest = join(root, 'artifacts', 'desktop-install')
await mkdir(dest, { recursive: true })
const packed = packJson(await run(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', dest], root))
const tarball = join(dest, packed.filename)
if (!existsSync(tarball)) throw new Error(`未生成安装包：${tarball}`)
const tgzMarker = `dsh-database-${packed.version}.tgz`

const checkout = await realpath(root)
const installed = []
for (const [label, home, profile] of homes) {
  const profileDir = join(home, 'profiles', profile)
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (!manifest.dependencies?.['dsh-database'] && !manifest.dsh?.profile?.bundles?.includes('dsh-database')) continue
  const pnpmVersion = await profilePnpm(profileDir)
  const inboxDir = join(home, 'plugin-inbox', `dsh-database-${packed.version}`)
  await mkdir(inboxDir, { recursive: true })
  const inboxTgz = join(inboxDir, tgzMarker)
  await copyFile(tarball, inboxTgz)
  await unlinkSource(join(profileDir, 'node_modules', 'dsh-database'), checkout)
  await run(process.execPath, [npmCli, 'exec', `--package=pnpm@${pnpmVersion}`, '--yes', '--', 'pnpm', 'add', inboxTgz], profileDir)
  installed.push(`${label} (pnpm@${pnpmVersion} add ${tgzMarker}): ${await assertPackage(home, profile, packed.version, checkout, tgzMarker)}`)
}
if (!installed.length) throw new Error('没有找到已安装 dsh-database 的 Desktop/CLI profile。')
console.log(JSON.stringify({ version: packed.version, tarball, installed }, null, 2))

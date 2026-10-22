import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startStandalone, type StandaloneOptions, type StandaloneServer } from './serve.ts'

export type DshProfile = 'web' | 'desktop'

export function parseLaunchArgs(argv: readonly string[]): { standalone: boolean } {
  const args = argv.filter(arg => arg !== '--')
  const unknown = args.filter(arg => arg !== '--standalone')
  if (unknown.length) throw new Error(`未知参数：${unknown.join(' ')}`)
  return { standalone: args.includes('--standalone') }
}

export function detectDshProfiles(options: { env?: NodeJS.ProcessEnv; home?: string; exists?: (path: string) => boolean } = {}): DshProfile[] {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const exists = options.exists ?? existsSync
  const found: DshProfile[] = []
  const add = (profile: DshProfile) => { if (!found.includes(profile)) found.push(profile) }
  const appdata = env.APPDATA?.trim()
  if (appdata && exists(join(appdata, 'dsh-desktop', 'harness', 'profiles', 'web', 'package.json'))) add('web')
  if (exists(join(home, '.dsh', 'profiles', 'web', 'package.json'))) add('web')
  if (exists(join(home, '.dsh', 'profiles', 'desktop', 'package.json'))) add('desktop')
  return found
}

export function resolvePluginTarball(env: NodeJS.ProcessEnv = process.env, directories: readonly string[] = []): string {
  const explicit = env.DSH_DATABASE_TGZ?.trim()
  if (explicit) return explicit
  for (const directory of directories) {
    if (!existsSync(directory)) continue
    const match = readdirSync(directory).find(name => /^dsh-database-.*\.tgz$/i.test(name))
    if (match) return join(directory, match)
  }
  throw new Error('未找到 dsh-database 安装包（.tgz）。')
}

export function installDshPlugin(profiles: readonly DshProfile[], tarball: string): Promise<void> {
  if (/["\r\n\0]/.test(tarball)) return Promise.reject(new Error('安装包路径无效。'))
  return profiles.reduce((chain, profile) => chain.then(() => new Promise<void>((resolvePromise, reject) => {
    const windows = process.platform === 'win32'
    // cmd needs to launch the DSH .cmd shim. Expanding a quoted environment value
    // preserves spaces and shell characters without interpolating the path as code.
    const child = spawn(windows ? 'cmd.exe' : 'dsh', windows
      ? ['/d', '/v:off', '/s', '/c', `"dsh plugin --profile ${profile} add "%DSH_DATABASE_INSTALL_TGZ%""`]
      : ['plugin', '--profile', profile, 'add', tarball], {
      stdio: 'inherit',
      windowsHide: true,
      windowsVerbatimArguments: windows,
      ...(windows ? { env: { ...process.env, DSH_DATABASE_INSTALL_TGZ: tarball } } : {}),
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`dsh plugin --profile ${profile} add failed (${code})`))
    })
  })), Promise.resolve())
}

export function openBrowser(url: string): void {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    return
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
  spawn(command, [url], { detached: true, stdio: 'ignore' }).unref()
}

export interface LaunchIo {
  args?: readonly string[]
  env?: NodeJS.ProcessEnv
  home?: string
  exists?: (path: string) => boolean
  directories?: readonly string[]
  installPlugin?: (profiles: readonly DshProfile[], tarball: string) => Promise<void>
  resolveTarball?: () => string
  start?: (options: StandaloneOptions) => Promise<StandaloneServer>
  openBrowser?: (url: string) => void
  log?: (message: string) => void
}

export async function runLaunch(io: LaunchIo = {}): Promise<{ mode: 'plugin' | 'standalone'; url?: string; close?: () => Promise<void> }> {
  const args = parseLaunchArgs(io.args ?? [])
  const log = io.log ?? (message => console.log(message))
  if (!args.standalone) {
    const profiles = detectDshProfiles({ env: io.env, home: io.home, exists: io.exists })
    if (profiles.length) {
      const tarball = (io.resolveTarball ?? (() => resolvePluginTarball(io.env, io.directories ?? [process.cwd()])))()
      await (io.installPlugin ?? installDshPlugin)(profiles, tarball)
      log('已安装到 DSH。请重启 dsh web 或 Desktop 后，从对话侧栏打开数据库。')
      return { mode: 'plugin' }
    }
  }
  const started = await (io.start ?? startStandalone)({ env: io.env })
  log(`访问地址：${started.url}`)
  ;(io.openBrowser ?? openBrowser)(started.url)
  return { mode: 'standalone', url: started.url, close: () => started.close() }
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  const left = resolve(entry)
  const right = fileURLToPath(import.meta.url)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

if (isDirectRun()) {
  runLaunch({
    args: process.argv.slice(2),
    directories: [fileURLToPath(new URL('..', import.meta.url)), process.cwd()],
  }).then(result => {
    if (result.mode !== 'standalone' || !result.close) return
    const shutdown = () => { void result.close?.().finally(() => process.exit(0)) }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }).catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}

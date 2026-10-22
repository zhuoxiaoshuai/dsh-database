import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { ConnectionService } from './host/connection-service.ts'
import { connectionApi } from './host/connection-api.ts'
import { ExecutionStore } from './host/execution-store.ts'

export const STANDALONE_PORT = 17890
export const STANDALONE_OWNER = 'local'

const STATIC_FILES = {
  '/': ['index.html', 'text/html'],
  '/preview.js': ['preview.js', 'text/javascript'],
  '/preview.css': ['preview.css', 'text/css'],
} as const

export function standaloneRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.DSH_DATABASE_HOME?.trim()
  if (override) return override
  return join(home, '.dsh-database')
}

export function standalonePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PORT?.trim()
  if (!raw) return STANDALONE_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT 无效：${raw}`)
  return port
}

export function defaultWorkerUrl(): URL {
  const bundled = fileURLToPath(new URL('./connection-worker.mjs', import.meta.url))
  if (existsSync(bundled)) return new URL('./connection-worker.mjs', import.meta.url)
  return new URL('./host/connection-worker.mjs', import.meta.url)
}

export function defaultAssetsDir(): string {
  const bundled = fileURLToPath(new URL('./preview/', import.meta.url))
  if (existsSync(join(bundled, 'index.html'))) return bundled
  return fileURLToPath(new URL('../lib/preview/', import.meta.url))
}

export interface StandaloneOptions {
  port?: number
  root?: string
  env?: NodeJS.ProcessEnv
  workerUrl?: URL
  assetsDir?: string
}

export interface StandaloneServer {
  server: Server
  url: string
  root: string
  port: number
  close(): Promise<void>
}

export async function startStandalone(options: StandaloneOptions = {}): Promise<StandaloneServer> {
  const env = options.env ?? process.env
  const root = options.root ?? standaloneRoot(env)
  const port = options.port ?? standalonePort(env)
  const workerUrl = options.workerUrl ?? defaultWorkerUrl()
  const assetsDir = options.assetsDir ?? defaultAssetsDir()
  const executions = new ExecutionStore(root)
  const service = new ConnectionService(() => true, root, workerUrl, undefined, executions)
  const token = randomBytes(32).toString('hex')
  const server = createServer(async (req, res) => {
    const address = server.address()
    const actualPort = address && typeof address !== 'string' ? address.port : port
    const host = `127.0.0.1:${actualPort}`
    const cookieName = `db_standalone_${actualPort}`
    if (req.headers.host !== host) { res.writeHead(403); res.end(); return }
    const path = new URL(req.url || '/', `http://${host}`).pathname
    if (path === '/api/database/connections') {
      const authenticated = (req.headers.cookie || '').split(';').some(value => value.trim() === `${cookieName}=${token}`)
      if (!authenticated || (req.method === 'POST' && req.headers.origin !== `http://${host}`)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '请从本地工作台页面发起连接。' }))
        return
      }
      await connectionApi(service, executions, STANDALONE_OWNER, req, res)
      return
    }
    const route = STATIC_FILES[path as keyof typeof STATIC_FILES]
    if (!route || req.method !== 'GET') { res.writeHead(404); res.end(); return }
    try {
      const body = await readFile(join(assetsDir, route[0]))
      res.writeHead(200, {
        'Content-Type': `${route[1]}; charset=utf-8`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(path === '/' ? { 'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/` } : {}),
      })
      res.end(body)
    } catch { res.writeHead(503); res.end('Run npm run build first') }
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError)
        resolve()
      })
    })
  } catch (error) {
    await service.dispose()
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') {
    await service.dispose()
    throw new Error('监听失败。')
  }
  const url = `http://127.0.0.1:${address.port}/`
  return {
    server,
    url,
    root,
    port: address.port,
    async close() {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await service.dispose()
    },
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  const left = resolve(entry)
  const right = fileURLToPath(import.meta.url)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

if (isDirectRun()) {
  const started = await startStandalone()
  console.log(`访问地址：${started.url}`)
  const shutdown = () => { void started.close().finally(() => process.exit(0)) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { ConnectionService } from '../src/connection-service.ts'
import { connectionApi } from '../src/host/connection-api.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
export async function startPreview(port = 0) {
  const executions = new ExecutionStore()
  const workerUrl = new URL('../src/host/connection-worker.mjs', import.meta.url)
  const storageDirectory = await mkdtemp(resolve(tmpdir(), 'dsh-database-preview-'))
  const service = new ConnectionService(() => true, storageDirectory, workerUrl, undefined, executions), token = randomBytes(32).toString('hex')
  const routes = { '/': ['index.html', 'text/html'], '/preview.js': ['preview.js', 'text/javascript'], '/preview.css': ['preview.css', 'text/css'] }
  const server = createServer(async (req, res) => {
    const host = `127.0.0.1:${server.address().port}`, cookie = `db_preview_${server.address().port}`
    if (req.headers.host !== host) { res.writeHead(403); res.end(); return }
    const path = new URL(req.url, `http://${host}`).pathname
    if (path === '/api/database/connections') {
      const authenticated = (req.headers.cookie || '').split(';').some(value => value.trim() === `${cookie}=${token}`)
      if (!authenticated || (req.method === 'POST' && req.headers.origin !== `http://${host}`)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '请从本地工作台页面发起连接。' })); return }
      await connectionApi(service, executions, 'local-preview', req, res); return
    }
    const route = routes[new URL(req.url, 'http://localhost').pathname]
    if (!route || req.method !== 'GET') { res.writeHead(404); res.end(); return }
    try { const body = await readFile(resolve('lib/preview', route[0])); res.writeHead(200, { 'Content-Type': `${route[1]}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(path === '/' ? { 'Set-Cookie': `${cookie}=${token}; HttpOnly; SameSite=Strict; Path=/` } : {}) }); res.end(body) }
    catch { res.writeHead(503); res.end('Run npm run build first') }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  server.on('close', () => { void service.dispose().finally(() => rm(storageDirectory, { recursive: true, force: true })) })
  return { server, url: `http://127.0.0.1:${server.address().port}/` }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/preview.mjs')) {
  const { server, url } = await startPreview(Number(process.env.PORT || 0))
  console.log(`Database UI preview: ${url}`)
  process.on('SIGINT', () => server.close())
}

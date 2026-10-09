import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const outdir = resolve('artifacts/ui/unified-workspace')
await mkdir(outdir, { recursive: true })
await build({
  stdin: { resolveDir: resolve('.'), sourcefile: 'unified-workspace-fixture.tsx', loader: 'tsx', contents: `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { useRedisBindings } from './src/client/redis/workspace.tsx'
    import { SourceWorkspace } from './src/client/workspace/source/source-workspace.tsx'
    import { SqlToolbarTemplatePicker } from './src/client/sql-toolbar-template-picker.tsx'
    import './src/client/style.css'
    const connection = { id: 'redis-fixture', generation: 'g1', name: 'Fixture Redis', dialect: 'redis', environment: 'sit', database: '0', live: true, health: 'ready' }
    let aiDocument = { sourceId: 'redis', text: '', context: { database: '0' }, revision: 1, controller: 'ai' }
    let knowledge = []
    const bridge = {
      mode: 'host', connections: [connection], tables: () => [], execute: async () => { throw new Error('unsupported') },
      executeText: async (_connection, text, context) => {
        if (context.database !== '0') throw new Error('fixture execution target changed')
        document.body.dataset.textExecutionCalls = String(Number(document.body.dataset.textExecutionCalls || '0') + 1)
        return { result: { type: 'string', value: 'PONG' }, elapsedMs: 3 }
      },
      explorer: async (_connection, action, input) => {
        document.body.dataset.explorerCalls = String(Number(document.body.dataset.explorerCalls || '0') + 1)
        if (action === 'list') return { sourceId: 'redis', nodes: ['sample:key', 'command'].map(title => ({ ref: 'key:' + encodeURIComponent(title), title, kind: 'key', hasChildren: false })), complete: true }
        if (action === 'read') return { keyType: 'string', ttl: -1, value: { result: { type: 'string', value: 'sample value' } } }
        throw new Error('unexpected explorer action')
      },
      redis: async (_connection, action, input) => {
        if (action === 'redis-scan') return { cursor: '0', keys: ['sample:key', 'command'], complete: true }
        if (action === 'redis-key-suggest') { document.body.dataset.keySuggestCalls = String(Number(document.body.dataset.keySuggestCalls || '0') + 1); return { keys: ['sample:key'], complete: true } }
        if (action === 'redis-key') { document.body.dataset.keyReadCalls = String(Number(document.body.dataset.keyReadCalls || '0') + 1); return { keyType: 'string', ttl: -1, value: { result: { type: 'string', value: 'sample value' } } } }
        return { result: { type: 'string', value: 'PONG' }, elapsedMs: 3 }
      },
      executions: async (action, body) => {
        if (action === 'execution-wait') { await new Promise(resolve => setTimeout(resolve, 500)); return { revision: 0, items: [], events: [] } }
        if (action === 'execution-document-get') return { document: aiDocument }
        if (action === 'execution-document-update') { aiDocument = { ...aiDocument, text: body.text, revision: aiDocument.revision + 1, controller: 'user' }; return { document: aiDocument } }
        if (action === 'execution-document-control') { aiDocument = { ...aiDocument, controller: body.controller, revision: aiDocument.revision + 1 }; return { document: aiDocument } }
        if (action === 'execution-document-run') return { result: { type: 'string', value: 'PONG' }, elapsedMs: 3 }
        return { items: [] }
      },
      templates: async (action, body) => {
        if (action === 'knowledge-search') return { items: knowledge }
        if (action === 'knowledge-publish') { const item = { id: body.id || 'k1', familyId: 'f1', sourceId: 'redis', connectionId: connection.id, text: body.text, title: body.title || 'PING', summary: body.summary || '', tags: body.tags || [], fingerprint: 'abc', version: 1, archived: false, updatedAt: new Date().toISOString(), analysis: { operation: 'PING', risk: '', semantic: false } }; knowledge = [item]; return item }
        if (action === 'knowledge-archive') { knowledge = []; return { ok: true } }
        return {}
      },
    }
    function RedisStandardMount({ bridge, connection }) {
      const bindings = useRedisBindings(bridge, connection, 0, '0')
      return <SourceWorkspace bridge={bridge} connection={connection} {...bindings} />
    }
    createRoot(document.getElementById('app')).render(<div className="db-workbench"><RedisStandardMount connection={connection} bridge={bridge} /></div>)
    const sqlBridge = { templates: async (action, body) => {
      if (body.connectionId !== 'mysql-fixture') throw new Error('SQL template request lost its connection ID')
      if (action === 'template-search') return { items: [{ id: 'sql-1', title: '常用查询', summary: '查询示例' }] }
      if (action === 'template-get') return { id: 'sql-1', originalSql: 'SELECT 1' }
      throw new Error('unexpected template action')
    } }
    createRoot(document.getElementById('sql-picker')).render(<SqlToolbarTemplatePicker bridge={sqlBridge} connectionId="mysql-fixture" dialect="mysql" onInsert={sql => { document.getElementById('sql-inserted').textContent = sql }} />)
  ` },
  bundle: true, format: 'esm', outdir, entryNames: 'fixture', assetNames: 'fixture',
})
await writeFile(resolve(outdir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/fixture.css"><style>html,body,#app,.db-workbench{height:100%;margin:0}#sql-picker{position:fixed;top:8px;right:8px;z-index:100;width:180px;background:white}#sql-inserted{position:fixed;top:50px;right:8px;z-index:100}</style></head><body><div id="app"></div><div id="sql-picker"></div><div id="sql-inserted"></div><script type="module" src="/fixture.js"></script></body></html>')
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname === '/' ? '/index.html' : new URL(request.url, 'http://localhost').pathname
  try { const body = await readFile(resolve(outdir, `.${path}`)); response.writeHead(200, { 'Content-Type': path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : 'text/html' }); response.end(body) }
  catch { response.writeHead(404); response.end() }
})
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.locator('button[title="sample:key"]').first().click()
  await page.getByText('sample value', { exact: true }).waitFor()
  assert.ok(Number(await page.locator('body').getAttribute('data-explorer-calls')) >= 1)
  assert.ok(Number(await page.locator('body').getAttribute('data-key-read-calls')) >= 1)
  await page.getByRole('tab', { name: '命令台' }).click()
  const command = page.getByLabel('Redis 命令')
  await command.fill('GET ')
  await command.press('Control+Shift+Space')
  await page.locator('.cm-tooltip-autocomplete li').filter({ hasText: 'sample:key' }).first().waitFor({ timeout: 5000 }).catch(async error => {
    const debug = await page.evaluate(() => ({ editor: document.querySelector('[aria-label="Redis 命令"]')?.textContent,
      explorerCalls: document.body.dataset.explorerCalls, keySuggestCalls: document.body.dataset.keySuggestCalls,
      hints: [...document.querySelectorAll('.cm-tooltip-autocomplete li')].map(item => item.textContent) }))
    throw new Error(`${error.message}\n${JSON.stringify(debug)}`)
  })
  assert.equal(Number(await page.locator('body').getAttribute('data-key-suggest-calls') || '0'), 0)
  await command.fill('PING')
  await page.getByRole('button', { name: '执行', exact: true }).first().click()
  await page.getByText('PONG', { exact: true }).waitFor()
  await page.getByRole('tab', { name: 'AI Query' }).click()
  await page.getByLabel('Redis 命令').fill('PING')
  await page.getByRole('button', { name: '执行当前内容', exact: true }).click()
  await page.getByText('PONG', { exact: true }).waitFor()
  await page.getByRole('tab', { name: '经验库' }).click()
  await page.getByLabel('标题').fill('测试命令')
  await page.getByLabel('Redis 命令').fill('PING')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByText('测试命令').waitFor()
  await page.locator('#sql-picker').getByLabel('搜索经验库').fill('常用')
  await page.getByRole('button', { name: '常用查询' }).click()
  await page.locator('#sql-inserted').getByText('SELECT 1').waitFor()
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'PASS', checks: ['Redis explorer', 'Redis command', 'AI Query', 'knowledge save', 'shared tabs', 'SQL template connection binding'], pageErrors: errors }))
} finally { await page.close(); await browser.close(); await new Promise(resolve => server.close(resolve)) }
await import('./source-module-ui-acceptance.mjs')
await import('./redis-read-ui-acceptance.mjs')

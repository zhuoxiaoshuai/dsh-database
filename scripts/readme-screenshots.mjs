/** Capture current workbench UI into docs/screenshots for the README. */
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const outdir = resolve('artifacts/ui/readme-screenshots')
const shots = resolve('docs/screenshots')
await mkdir(outdir, { recursive: true })
await mkdir(shots, { recursive: true })

await build({
  stdin: { resolveDir: resolve('.'), sourcefile: 'readme-screenshots.tsx', loader: 'tsx', contents: `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { WorkbenchShell } from './src/client/workspace/shell/workbench-shell.tsx'
    import './src/client/style.css'

    const kafka = { id: 'kafka-fixture', generation: 'g1', name: 'Kafka · 127.0.0.1', dialect: 'kafka', environment: 'sit', database: '', live: true, health: 'ready' }
    const redis = { id: 'redis-fixture', generation: 'g1', name: 'Redis · local', dialect: 'redis', environment: 'sit', database: '0', databases: ['0', '1', '2'], version: '7.2', live: true, health: 'ready' }
    const mysql = { id: 'mysql-fixture', generation: 'g1', name: 'MySQL · local', dialect: 'mysql', environment: 'sit', database: 'business', version: '8.4', live: true, health: 'ready' }
    const oracle = { id: 'oracle-fixture', generation: 'g1', name: 'Oracle · local', dialect: 'oracle', environment: 'sit', database: 'BUSINESS', version: '23', live: true, health: 'ready' }
    let aiDocument = { sourceId: 'kafka', text: 'PEEK orders 0 20', context: { topic: 'orders', partition: '0' }, revision: 1, controller: 'ai' }
    const sqlRows = [
      ['2', '1.2300', 'other session'],
      ['9007199254740993', '9007199254740993.1234', '{"id":9007199254740993}'],
    ]

    const bridge = {
      mode: 'host', connections: [mysql, oracle, redis, kafka], tables: () => [
        { schema: 'business', name: 'records', type: 'BASE TABLE' },
        { schema: 'business', name: 'payments', type: 'BASE TABLE' },
      ],
      execute: async () => ({ columns: ['id', 'amount', 'note'], rows: sqlRows, truncated: false, elapsedMs: 4 }),
      executeManual: async () => ({ columns: ['id', 'amount', 'note'], rows: sqlRows, truncated: false, elapsedMs: 4 }),
      catalog: async (item, input) => {
        if (item?.dialect === 'mysql' && input?.kind === 'schemas') return { items: [{ name: 'business' }, { name: 'inventory' }], more: false, collectedAt: '', source: 'live' }
        if (item?.dialect === 'oracle' && input?.kind === 'schemas') return { items: [{ name: 'BUSINESS' }, { name: 'SYS' }, { name: 'SYSTEM' }], more: false, collectedAt: '', source: 'live' }
        if ((item?.dialect === 'mysql' || item?.dialect === 'oracle') && input?.kind === 'tables') return { items: [{ name: 'records', type: 'BASE TABLE' }, { name: 'payments', type: 'BASE TABLE' }], more: false, collectedAt: '', source: 'live' }
        if (input?.kind === 'table') return {
          columns: [{ name: 'id', type: 'BIGINT' }, { name: 'amount', type: 'DECIMAL(20,4)' }, { name: 'note', type: 'JSON' }],
          primaryKeys: ['id'], indexes: { status: 'actual', values: [{ name: 'PRIMARY', unique: true, type: 'BTREE', columns: ['id'] }] },
          constraints: { status: 'actual', values: [{ name: 'PRIMARY', type: 'primary', columns: ['id'] }] },
          collectedAt: '', source: 'live',
        }
        return { items: [], more: false, collectedAt: '', source: 'live' }
      },
      explorer: async (connection, action, input) => {
        if (connection.dialect === 'redis') {
          if (action === 'list') return { sourceId: 'redis', nodes: ['session:10081', 'cart:10082', 'lock:order'].map(title => ({ ref: 'key:' + encodeURIComponent(title), title, kind: 'key', hasChildren: false })), complete: true }
          if (action === 'read') return { keyType: 'string', ttl: 3600, value: { result: { type: 'string', value: '{"user":"demo","ttl":3600}' } } }
        }
        if (action === 'list') {
          if (input.parent === 'folder:groups') return { sourceId: 'kafka', nodes: [{ ref: 'group:billing', title: 'billing', kind: 'group', hasChildren: true }], complete: true }
          return { sourceId: 'kafka', nodes: [
            { ref: 'topic:app-logs', title: 'app-logs', kind: 'topic', hasChildren: false },
            { ref: 'topic:orders', title: 'orders', kind: 'topic', hasChildren: false },
          ], complete: true }
        }
        if (action === 'read') {
          if (String(input.ref).startsWith('group:')) return { kind: 'group', groupId: 'billing', members: [], topics: ['orders'] }
          return { kind: 'topic', topic: 'orders', partitions: [
            { partition: 0, leader: 1, replicas: [1, 2], low: '0', high: '1280' },
            { partition: 1, leader: 2, replicas: [1, 2], low: '8', high: '8' },
          ] }
        }
        throw new Error('unexpected explorer action')
      },
      redis: async (_connection, action) => {
        if (action === 'redis-scan') return { cursor: '0', keys: ['session:10081', 'cart:10082', 'lock:order'], complete: true }
        if (action === 'redis-key') return { keyType: 'string', ttl: 3600, value: { result: { type: 'string', value: '{"user":"demo","ttl":3600}' } } }
        return { result: { type: 'string', value: 'PONG' }, elapsedMs: 2 }
      },
      maintenance: async () => ({
        source: 'table', canEnable: true, canInsert: true, canUpdate: true, canDelete: true, reason: '',
        primaryKeys: ['id'], resultPrimaryKeys: ['id'], identityColumns: [],
        columns: [
          { resultColumn: 'id', sourceColumn: 'id', editable: false },
          { resultColumn: 'amount', sourceColumn: 'amount', editable: true },
          { resultColumn: 'note', sourceColumn: 'note', editable: true },
        ],
      }),
      executions: async (action, body) => {
        if (action === 'execution-wait') { await new Promise(resolve => setTimeout(resolve, 400)); return { revision: 0, items: [], events: [] } }
        if (action === 'execution-document-get') return { document: aiDocument }
        if (action === 'execution-document-update') { aiDocument = { ...aiDocument, text: body.text, revision: aiDocument.revision + 1, controller: 'user' }; return { document: aiDocument } }
        if (action === 'execution-document-run') return { result: { type: 'string', value: 'PONG' }, elapsedMs: 2 }
        return { items: [] }
      },
    }

    function Fixture() {
      const [rows, setRows] = useState([mysql, oracle, redis, kafka])
      const [id, setId] = useState(kafka.id)
      const active = rows.find(item => item.id === id) || rows[0]
      return <div className="db-workbench"><WorkbenchShell
        bridge={bridge} conversationId="fixture" connection={active} connections={rows}
        onPick={setId} onAdd={() => {}} onEdit={() => {}}
        onWorkbench={(target, patch) => setRows(current => current.map(item => item.id === target ? { ...item, workbench: { ...item.workbench, ...patch } } : item))}
      /></div>
    }
    createRoot(document.getElementById('app')).render(<Fixture />)
  ` },
  bundle: true, format: 'esm', outdir, entryNames: 'fixture', assetNames: 'fixture',
})
await writeFile(resolve(outdir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/fixture.css"><style>html,body,#app,.db-workbench,.db-shell{height:100%;margin:0;background:#f6f7f8}</style></head><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>')

const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname === '/' ? '/index.html' : new URL(request.url, 'http://localhost').pathname
  try {
    const body = await readFile(resolve(outdir, `.${path}`))
    response.writeHead(200, { 'Content-Type': path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : 'text/html' })
    response.end(body)
  } catch { response.writeHead(404); response.end() }
})
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
const browser = await chromium.launch({ channel: 'msedge', headless: true }).catch(() => chromium.launch({ headless: true }))
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', error => errors.push(error.message))
const sidebar = () => page.getByLabel('我的连接')
const shot = (name) => page.locator('.db-workbench').screenshot({ path: resolve(shots, name), type: 'png' })
const dump = async (name) => { await page.screenshot({ path: resolve(outdir, name), type: 'png', fullPage: true }).catch(() => {}) }
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.getByText('Kafka · 127.0.0.1').waitFor()
  await sidebar().getByText('Topics', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'orders' }).waitFor()
  await shot('workbench.png')
  await page.getByRole('button', { name: 'orders' }).click()
  await page.getByText('副本因子 2').waitFor()
  await shot('kafka-topic.png')
  await sidebar().getByText('Redis · local', { exact: true }).click()
  await sidebar().locator('.db-schema-node').filter({ hasText: 'db0' }).click()
  await page.locator('button[title="session:10081"]').waitFor()
  await page.locator('button[title="session:10081"]').click()
  await page.getByText('{"user":"demo","ttl":3600}').waitFor()
  await shot('redis-keys.png')
  await sidebar().getByText('MySQL · local', { exact: true }).click()
  await sidebar().locator('.db-schema-node').filter({ hasText: /^business$/ }).click()
  await page.getByRole('button', { name: 'records', exact: true }).click()
  await page.getByRole('button', { name: '打开表', exact: true }).click()
  await page.getByText('9007199254740993').first().waitFor()
  await shot('mysql-results.png')
  await sidebar().getByText('Oracle · local', { exact: true }).click()
  await sidebar().locator('.db-schema-node').filter({ hasText: /^BUSINESS$/ }).waitFor()
  await shot('oracle-catalog.png')
  if (errors.length) throw new Error(errors.join('\n'))
  for (const stale of ['dsh-sidebar.png', 'mysql-workbench.png']) {
    await unlink(resolve(shots, stale)).catch(() => {})
  }
  console.log(JSON.stringify({ status: 'PASS', files: ['workbench.png', 'kafka-topic.png', 'redis-keys.png', 'mysql-results.png', 'oracle-catalog.png'], pageErrors: errors }))
} catch (error) {
  await dump('failure.png')
  console.error(JSON.stringify({ status: 'FAIL', error: error instanceof Error ? error.message : String(error), pageErrors: errors }))
  process.exitCode = 1
} finally {
  await page.close()
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const outdir = resolve('artifacts/ui/kafka-catalog-tree')
await mkdir(outdir, { recursive: true })
await build({
  stdin: { resolveDir: resolve('.'), sourcefile: 'kafka-catalog-tree-fixture.tsx', loader: 'tsx', contents: `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { WorkbenchShell } from './src/client/workspace/shell/workbench-shell.tsx'
    import './src/client/style.css'

    const kafka = {
      id: 'kafka-fixture', generation: 'g1', name: 'Kafka · 127.0.0.1', dialect: 'kafka',
      environment: 'sit', database: '', live: true, health: 'ready',
    }
    const redis = {
      id: 'redis-fixture', generation: 'g1', name: 'Redis · local', dialect: 'redis',
      environment: 'sit', database: '0', databases: ['0', '1', '2'], version: '7', live: true, health: 'ready',
    }
    const mysql = {
      id: 'mysql-fixture', generation: 'g1', name: 'MySQL · local', dialect: 'mysql',
      environment: 'sit', database: 'app', version: '8', live: true, health: 'ready',
    }
    const aiDocument = { sourceId: 'kafka', text: '', context: {}, revision: 1, controller: 'ai' }
    const bridge = {
      mode: 'host', connections: [kafka], tables: () => [],
      execute: async () => { throw new Error('unused') },
      catalog: async (item, input) => {
        if (item?.dialect === 'mysql' && input?.kind === 'schemas') return { items: [{ name: 'app' }, { name: 'hr' }], more: false, collectedAt: '', source: 'test' }
        return { items: [], more: false, collectedAt: '', source: 'test' }
      },
      explorer: async (_connection, action, input) => {
        if (action === 'list') {
          if (input.parent === 'folder:groups') {
            return { sourceId: 'kafka', nodes: [{ ref: 'group:billing', title: 'billing', kind: 'group', hasChildren: true }], complete: true }
          }
          return { sourceId: 'kafka', nodes: [
            { ref: 'topic:app-logs', title: 'app-logs', kind: 'topic', hasChildren: false },
            { ref: 'topic:orders', title: 'orders', kind: 'topic', hasChildren: false },
          ], complete: true }
        }
        if (action === 'read') {
          if (String(input.ref).startsWith('group:')) return { kind: 'group', groupId: 'billing', members: [], topics: ['orders'] }
          return { kind: 'topic', topic: 'orders', partitions: [
            { partition: 0, leader: 1, replicas: [1, 2], low: '0', high: '12' },
            { partition: 1, leader: -1, replicas: [1, 2], low: '8', high: '8' },
          ] }
        }
        throw new Error('unexpected explorer action')
      },
      executions: async (action) => {
        if (action === 'execution-wait') { await new Promise(resolve => setTimeout(resolve, 500)); return { revision: 0, items: [], events: [] } }
        if (action === 'execution-document-get') return { document: aiDocument }
        return { items: [] }
      },
    }
    function Fixture() {
      const [rows, setRows] = useState([kafka, redis, mysql])
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
await writeFile(resolve(outdir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/fixture.css"><style>html,body,#app,.db-workbench,.db-shell{height:100%;margin:0}</style></head><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>')
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname === '/' ? '/index.html' : new URL(request.url, 'http://localhost').pathname
  try {
    const body = await readFile(resolve(outdir, `.${path}`))
    response.writeHead(200, { 'Content-Type': path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : 'text/html' })
    response.end(body)
  } catch { response.writeHead(404); response.end() }
})
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  if (errors.length) throw new Error(errors.join('\n'))
  await page.getByText('Kafka · 127.0.0.1').waitFor()
  const sidebar = page.getByLabel('我的连接')
  await sidebar.getByText('Topics', { exact: true }).waitFor()
  await sidebar.getByText('消费组', { exact: true }).waitFor()
  assert.equal(await page.locator('.db-search-tree-head > span').innerText(), 'Topics')
  assert.equal(await page.locator('.db-search-tree-modes').count(), 0)
  await page.getByRole('button', { name: 'orders' }).waitFor()
  await page.getByRole('button', { name: 'orders' }).click()
  await page.getByRole('columnheader', { name: '副本' }).waitFor()
  await page.getByText('副本因子 2').waitFor()
  await page.getByText('8 · 空', { exact: true }).waitFor()
  await page.getByRole('cell', { name: '无', exact: true }).waitFor()
  await sidebar.locator('.db-schema-node').filter({ hasText: '消费组' }).click()
  await page.locator('.db-search-tree-head > span', { hasText: '消费组' }).waitFor()
  await page.locator('.db-search-tree-body').getByText('billing', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'orders' }).count(), 0)
  assert.equal(await page.locator('.db-search-tree-head button[aria-pressed]').count(), 0)
  const showOnly = async (connectionName, menuLabel, keepLabels) => {
    await page.getByRole('button', { name: `更多 ${connectionName} 操作`, exact: true }).click()
    await page.getByRole('button', { name: menuLabel, exact: true }).click()
    await page.getByRole('button', { name: '清空', exact: true }).click()
    for (const label of keepLabels) await page.getByRole('checkbox', { name: label, exact: true }).check()
    await page.getByRole('button', { name: '保存', exact: true }).click()
  }
  await showOnly('Kafka · 127.0.0.1', '显示的分类', ['消费组'])
  await sidebar.getByText('Topics', { exact: true }).waitFor({ state: 'detached' })
  await sidebar.getByText('消费组', { exact: true }).waitFor()
  await page.getByRole('button', { name: '更多 Kafka · 127.0.0.1 操作', exact: true }).click()
  await page.getByRole('button', { name: '显示的分类', exact: true }).click()
  await page.getByRole('button', { name: '清空', exact: true }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await sidebar.getByText('Topics', { exact: true }).waitFor()
  await sidebar.locator('.db-schema-node').filter({ hasText: 'db1' }).click()
  await showOnly('Redis · local', '显示的数据库', ['db1', 'db2'])
  await sidebar.getByText('db0', { exact: true }).waitFor({ state: 'detached' })
  await sidebar.getByText('db1', { exact: true }).waitFor()
  await sidebar.getByText('db2', { exact: true }).waitFor()
  await sidebar.getByText('app', { exact: true }).waitFor()
  await sidebar.getByText('hr', { exact: true }).waitFor()
  await sidebar.locator('.db-schema-node').filter({ hasText: 'app' }).click()
  await showOnly('MySQL · local', '显示的数据库', ['app'])
  await sidebar.getByText('hr', { exact: true }).waitFor({ state: 'detached' })
  await sidebar.getByText('app', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'PASS', checks: ['left catalog roots', 'topics list', 'describe table', 'groups from left tree', 'no right switcher', 'kafka child filter', 'redis child filter', 'mysql child filter'], pageErrors: errors }))
} finally { await page.close(); await browser.close(); await new Promise(resolve => server.close(resolve)) }

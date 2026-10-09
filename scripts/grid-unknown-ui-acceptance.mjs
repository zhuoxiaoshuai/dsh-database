import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
const outdir = resolve('artifacts/ui/grid-unknown')
await mkdir(outdir, { recursive: true })
await build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ObjectWorkspace } from './src/client/object-workspace.tsx'
import { SqlWorkspaceTab } from './src/client/sql-workspace-tab.tsx'
import { SchemaCache } from './src/client/schema/schema-cache.ts'
import './src/client/style.css'
const kind = new URLSearchParams(location.search).get('kind')
const connection = { id: 'fixture', generation: 'original', name: 'Fixture', dialect: 'mysql', environment: 'sit', database: 'app', live: true }
const rows = [['1','one'],['2','two']], previews = new Map()
let count = 0
const capability = { source: 'query', id: 'cap', schema: 'app', table: 'demo', canEnable: true, canUpdate: true, canInsert: false, canDelete: false, reason: '', primaryKeys: ['id'], resultPrimaryKeys: ['id'], identityColumns: [], columns: [{ resultColumn: 'id', sourceColumn: 'id', editable: false }, { resultColumn: 'value', sourceColumn: 'value', editable: true }] }
const bridge = { mode: 'host', tables: () => [],
  catalog: async () => ({ columns: [{ name: 'id', key: 'PRI', primaryKey: true, type: 'INT' }, { name: 'value', type: 'VARCHAR' }], indexes: { values: [] } }),
  execute: async (connection, sql) => {
    (window.reads ||= []).push({ target: connection.database, sql })
    if (window.failRead) { window.failRead = false; throw new Error('fresh read failed') }
    return { columns: ['id','value'], rows: rows.map(row => [...row]), elapsedMs: 1, truncated: false }
  },
  maintenance: async (_connection, input) => {
    (window.maintenanceCalls ||= []).push(input.kind)
    if (input.kind === 'capability') return capability
    if (input.kind === 'enable') return { enabled: input.enabled }
    if (input.kind === 'preview') { const id = 'p' + previews.size; previews.set(id, input.operation); return { id, sql: 'UPDATE demo SET value=? WHERE id=?', params: [input.operation.values.value, input.operation.original.id] } }
    if (input.kind === 'execute') {
      ++count; window.writes = count
      const op = previews.get(input.id), row = rows.find(row => row[0] === op.original.id)
      row[1] = op.values.value
      return count === 2 ? { status: 'unknown', message: 'lost second receipt' } : { status: 'success' }
    }
    return {}
  }
}
const cache = new SchemaCache(bridge.catalog, { prewarmTableLimit: 0 })
const props = { bridge, connection, schema: 'app', cache, onStatus() {} }
createRoot(document.getElementById('app')).render(kind === 'object'
  ? <ObjectWorkspace {...props} cache={undefined} table="demo" isView={false} sub="data" onSub={() => {}} />
  : <SqlWorkspaceTab {...props} schemas={['app']} initialSql="SELECT id,value FROM demo" onSql={() => {}} onSavedExperience={() => {}} onSchemaChange={() => {}} />)
` }, bundle: true, format: 'esm', outdir, entryNames: 'fixture', assetNames: 'fixture' })
await writeFile(resolve(outdir, 'index.html'), '<html><head><link rel="stylesheet" href="/fixture.css"><style>html,body,#app{height:100%;margin:0}</style></head><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>')
const server = createServer(async (req, res) => {
  try { const path = new URL(req.url, 'http://fixture').pathname; const data = await readFile(resolve(outdir, '.' + (path === '/' ? '/index.html' : path))); res.writeHead(200, { 'Content-Type': path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(data) }
  catch { res.writeHead(404); res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const errors = [], checks = []
try {
  for (const kind of ['object','sql']) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.goto('http://127.0.0.1:' + server.address().port + '/?kind=' + kind)
      if (kind === 'sql') await page.getByRole('button', { name: '运行', exact: true }).first().click()
      await page.getByRole('button', { name: '开启维护', exact: true }).click()
      for (const index of [0,1]) {
        await page.locator('td[data-row="' + index + '"][data-col="1"]').dblclick()
        await page.getByLabel('编辑 value', { exact: true }).fill('changed-' + index)
        await page.getByLabel('编辑 value', { exact: true }).press('Enter')
      }
      await page.getByRole('button', { name: kind === 'object' ? '保存' : '保存修改', exact: true }).click()
      await page.getByRole('dialog', { name: '确认提交' }).getByRole('button', { name: '确认', exact: true }).click()
      await page.getByLabel('未知写入核验').waitFor()
      assert.equal(await page.evaluate(() => window.writes), 2)
      await page.evaluate(() => { window.failRead = true })
      await page.getByRole('button', { name: '丢弃旧草稿并刷新', exact: true }).click()
      await page.getByText('fresh read failed', { exact: false }).first().waitFor()
      assert.equal(await page.getByLabel('未知写入核验').count(), 1)
      assert.equal(await page.getByLabel('编辑 value', { exact: true }).count(), 0)
      assert.equal(await page.evaluate(() => window.writes), 2)
      await page.getByRole('button', { name: '丢弃旧草稿并刷新', exact: true }).click()
      await page.getByLabel('未知写入核验').waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => window.writes), 2)
      const reads = await page.evaluate(() => window.reads)
      assert.equal(reads.at(-1).target, 'app'); assert.match(reads.at(-1).sql, /^SELECT/i)
      await page.getByRole('button', { name: '开启维护', exact: true }).click()
      await page.locator('td[data-row="1"][data-col="1"]').dblclick()
      await page.getByLabel('编辑 value', { exact: true }).waitFor()
      checks.push(kind + ': committed first item, uncertain second frozen, failed verification stays frozen, new successful read permits new editing, no replay')
    } catch (error) { console.log(JSON.stringify({ kind, errors, body: await page.locator('body').innerText(), calls: await page.evaluate(() => window.maintenanceCalls) })); await page.screenshot({ path: resolve(outdir, kind + '-failure.png') }); throw error }
    finally { await page.close() }
  }
  assert.deepEqual(errors, [])
  const report = { status: 'PASS', evidence: 'actual grid components, controlled bridge', checks, pageErrors: errors }
  await writeFile(resolve(outdir, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }

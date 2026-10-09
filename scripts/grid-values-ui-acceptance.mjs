import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
const outdir = resolve('artifacts/ui/grid-values')
await mkdir(outdir, { recursive: true })
await build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ObjectWorkspace } from './src/client/object-workspace.tsx'
import { SqlWorkspaceTab } from './src/client/sql-workspace-tab.tsx'
import { SchemaCache } from './src/client/schema/schema-cache.ts'
import { QueryResultGrid } from './src/client/query-result-grid.tsx'
import './src/client/style.css'
const kind = new URLSearchParams(location.search).get('kind')
const connection = { id: 'fixture', generation: 'original', name: 'Fixture', dialect: 'mysql', environment: 'sit', database: 'app', live: true }
const rows = [['1','one'],['2','two']], previews = new Map()
let count = 0
const capability = { source: 'query', id: 'cap', schema: 'app', table: 'demo', canEnable: true, canUpdate: true, canInsert: true, canDelete: false, reason: '', primaryKeys: ['id'], resultPrimaryKeys: ['id'], identityColumns: [], columns: [{ resultColumn: 'id', sourceColumn: 'id', editable: false }, { resultColumn: 'value', sourceColumn: 'value', editable: true }] }
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
    if (input.kind === 'preview') { (window.operations ||= []).push(input.operation); return { id: 'insert-preview', sql: 'INSERT bounded fixture', params: [] } }
    if (input.kind === 'execute') return { status: 'success' }
    return {}
  }
}
const cache = new SchemaCache(bridge.catalog, { prewarmTableLimit: 0 })
const props = { bridge, connection, schema: 'app', cache, onStatus() {} }
function BinaryGrid() {
  const [selected, select] = useState()
  const result = { columns: ['id', 'text', 'data', 'hex', 'json'], binaryColumns: [2, 3], rows: [['1', '[BLOB 4 bytes]', '中文 abcd', '0xff00', '{"id":9007199254740993}']], elapsedMs: 1, truncated: false }
  return <div className="db-workbench" style={{height:800}}><QueryResultGrid result={result} readOnly={false} allowInsert={false} primaryKeys={['id']} changed={{}} draftRows={[]} selected={selected}
    onSelect={select} onEditStart={() => {}} onEditCommit={() => {}} onEditCancel={() => {}} onRowSelect={() => {}}
    detailColumn={selected && result.columns[selected.col]} detailValue={selected && result.rows[selected.row]?.[selected.col]} detailEditable={true} onDetailApply={() => { window.applied = true }} /></div>
}
createRoot(document.getElementById('app')).render(kind === 'binary' ? <BinaryGrid /> : kind === 'object'
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
  const binary = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  binary.on('pageerror', error => errors.push(error.message))
  try {
    await binary.goto(`http://127.0.0.1:${server.address().port}/?kind=binary`)
    await binary.locator('td[data-row="0"][data-col="2"]').click()
    await binary.getByRole('button', { name: '展开字段详情' }).click()
    await binary.locator('.db-cell-detail').getByText('中文 abcd', { exact: true }).waitFor()
    assert.equal(await binary.getByRole('button', { name: '应用到单元格' }).count(), 0)
      await binary.locator('td[data-row="0"][data-col="4"]').click()
      assert.ok((await binary.getByLabel('编辑 json', { exact: true }).inputValue()).includes('9007199254740993'))
    await binary.locator('td[data-row="0"][data-col="1"]').click()
    await binary.getByLabel('编辑 text', { exact: true }).waitFor()
    assert.equal(await binary.getByLabel('编辑 text', { exact: true }).inputValue(), '[BLOB 4 bytes]')
    await binary.locator('td[data-row="0"][data-col="3"]').click()
    await binary.locator('.db-cell-detail').getByText('0xff00', { exact: true }).waitFor()
    assert.equal(await binary.getByRole('button', { name: '应用到单元格' }).count(), 0)
    checks.push('binary UTF-8 and hex details are readable and read-only; ordinary placeholder text stays editable')
  } finally { await binary.close() }
  for (const kind of ['object', 'sql']) for (const assignment of ['empty', 'null', 'default']) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.goto('http://127.0.0.1:' + server.address().port + '/?kind=' + kind)
      if (kind === 'sql') await page.getByRole('button', { name: '运行', exact: true }).first().click()
      await page.getByRole('button', { name: '开启维护', exact: true }).click()
      await page.getByRole('button', { name: '新增', exact: true }).click()
      const save = page.getByRole('button', { name: kind === 'object' ? '保存' : '保存修改', exact: true })
      await save.click()
      await page.getByText('新增行没有可提交字段', { exact: false }).first().waitFor()
      assert.equal(await page.evaluate(() => window.operations?.length || 0), 0)
      const cell = page.locator('td[data-row="-1"][data-col="1"]')
      await cell.click({ button: 'right' })
      await page.getByRole('button', { name: '设置为 NULL', exact: true }).click()
      if (assignment !== 'null') {
        await cell.click({ button: 'right' })
        await page.getByRole('button', { name: '使用默认值', exact: true }).click()
        assert.match(await cell.innerText(), /默认值/)
        if (assignment === 'empty') {
          await cell.click({ button: 'right' })
          await page.getByRole('button', { name: '设置为空字符串', exact: true }).click()
        } else {
          await page.locator('td[data-row="-1"][data-col="0"]').dblclick()
          await page.getByLabel('编辑 id', { exact: true }).fill('77')
          await page.getByLabel('编辑 id', { exact: true }).press('Enter')
        }
      }
      await save.click()
      await page.getByRole('dialog', { name: '确认提交' }).getByRole('button', { name: '确认', exact: true }).click()
      await page.waitForFunction(() => window.operations?.length === 1)
      const operation = await page.evaluate(() => window.operations[0])
      assert.equal(operation.kind, 'insert')
      assert.deepEqual(operation.values, assignment === 'empty' ? { value: '' } : assignment === 'null' ? { value: null } : { id: '77' })
      checks.push(kind + ': ' + assignment + ' preserved; unassigned fields omitted, all-unassigned never previews')
    } catch (error) { console.log(JSON.stringify({ kind, assignment, errors, body: await page.locator('body').innerText() })); throw error }
    finally { await page.close() }
  }
  assert.deepEqual(errors, [])
  const report = { status: 'PASS', evidence: 'actual grid components, controlled bridge', checks, pageErrors: errors }
  await writeFile(resolve(outdir, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }

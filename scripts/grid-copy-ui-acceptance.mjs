import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const outdir = resolve('artifacts/ui/grid-copy')
await mkdir(outdir, { recursive: true })
await build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryResultGrid } from './src/client/query-result-grid.tsx'
import { QueryResultFrame } from './src/client/workspace/source/query-result-frame.tsx'
import './src/client/style.css'
window.copied = ''
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copied = text } } })
function Fixture() {
  const readOnly = new URLSearchParams(location.search).get('readonly') === '1'
  const [dark, setDark] = useState(false)
  const [result, setResult] = useState({ columns: ['id', 'note', 'extra'], rows: [['1', "a'b", 'x'], ['2', '', null]], elapsedMs: 1, truncated: false })
  const [draftRows, setDraftRows] = useState([{ id: 'draft', values: { id: '3', note: 'draft', extra: 'new' } }])
  const [selected, setSelected] = useState()
  const [editing, setEditing] = useState()
  const [changed, setChanged] = useState({})
  const [sortOrder, setSortOrder] = useState(null)
  window.refreshResult = () => setResult(old => ({ ...old, rows: old.rows.map(row => [...row]) }))
  window.emptyResult = () => { setResult(old => ({ ...old, rows: [] })); setDraftRows([]); setSelected(undefined) }
  return <div className={'db-workbench' + (dark ? ' db-dark' : '')}>
    <button id="theme" onClick={() => setDark(value => !value)}>切换主题</button>
    <QueryResultFrame summary="controlled fixture">
      <QueryResultGrid result={result} readOnly={readOnly} allowInsert={!readOnly} primaryKeys={['id']} draftRows={draftRows} changed={changed}
        selected={selected} editing={editing} onSelect={setSelected} onRowSelect={row => setSelected({ row, col: 0 })}
        onEditStart={setEditing} onEditCancel={() => setEditing(undefined)}
        onEditCommit={(pos, value) => { setChanged(old => ({ ...old, [result.rows[pos.row][0]]: { note: value } })); setEditing(undefined) }}
        onDraftChange={(id, column, value) => setDraftRows(old => old.map(row => row.id === id ? { ...row, values: { ...row.values, [column]: value } } : row))}
        sortField="id" sortOrder={sortOrder} onSort={() => { window.sortCalls = (window.sortCalls || 0) + 1; setSortOrder(old => old === 'ASC' ? 'DESC' : 'ASC') }}
        columnTypes={['int', 'varchar', 'varchar']} onCopyError={message => { throw new Error(message) }}
        extraMenu={<button onClick={() => { window.extraCalls = (window.extraCalls || 0) + 1 }}>单元格操作</button>}
        detailColumn={selected ? result.columns[selected.col] : undefined} detailValue={selected ? result.rows[selected.row]?.[selected.col] : undefined}
      />
    </QueryResultFrame>
  </div>
}
createRoot(document.getElementById('app')).render(<Fixture />)
` }, bundle: true, format: 'esm', outdir, entryNames: 'fixture', assetNames: 'fixture' })
await writeFile(resolve(outdir, 'index.html'), '<html><head><link rel="stylesheet" href="/fixture.css"><style>html,body,#app{height:100%;margin:0}#app>.db-workbench{max-width:900px;margin:auto}.db-query-result-frame{flex:1;min-height:0}</style></head><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>')
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://fixture').pathname
    const data = await readFile(resolve(outdir, '.' + (pathname === '/' ? '/index.html' : pathname)))
    res.writeHead(200, { 'Content-Type': pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(data)
  } catch { res.writeHead(404); res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
const checks = [], pageErrors = []
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  for (const readonly of [0, 1]) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}/?readonly=${readonly}`)
    const header = name => page.getByRole('button', { name: '选中列 ' + name, exact: true })
    const cell = (row, col) => page.locator(`td[data-row="${row}"][data-col="${col}"]`)
    const selectedColumns = () => page.locator('th.is-column-selected').evaluateAll(nodes => nodes.map(node => Number(node.dataset.col)))
    const copyKey = async () => { await page.locator('.db-grid-scroll').press('Control+c'); return page.evaluate(() => window.copied) }
    const drag = async (from, to, returnToStart = false) => {
      const a = await from.boundingBox(), b = await to.boundingBox()
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
      await page.mouse.down()
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 })
      if (returnToStart) await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2, { steps: 10 })
      await page.mouse.up()
    }
    const commaData = async () => {
      await page.getByRole('menuitem', { name: '逗号分隔', exact: true }).hover()
      await page.getByRole('menu', { name: '逗号分隔', exact: true }).getByRole('menuitem', { name: '数据', exact: true }).click()
      return page.evaluate(() => window.copied)
    }
    await drag(header('id'), header('extra'))
    assert.deepEqual(await selectedColumns(), [0, 1, 2])
    assert.equal(await page.locator('td.is-cell-range').count(), 9)
    assert.equal(await copyKey(), "3\tdraft\tnew\n1\ta'b\tx\n2\t\"\"\tNULL")
    await drag(header('extra'), header('id'))
    assert.deepEqual(await selectedColumns(), [0, 1, 2])
    await drag(header('note'), header('extra'), true)
    assert.deepEqual(await selectedColumns(), [1])
    assert.equal(await copyKey(), "draft\na'b\n\"\"")
    await drag(header('id'), page.getByRole('button', { name: '排序 extra', exact: true }))
    assert.deepEqual(await selectedColumns(), [0, 1, 2])
    assert.equal(await page.evaluate(() => window.sortCalls || 0), 0)
    // A release outside the grid must not consume the next normal header click.
    const origin = await header('id').boundingBox(), across = await header('extra').boundingBox()
    await page.mouse.move(origin.x + 10, origin.y + 10)
    await page.mouse.down()
    await page.mouse.move(across.x + 10, across.y + 10, { steps: 8 })
    await page.mouse.move(30, 350)
    await page.mouse.up()
    await header('note').click()
    assert.deepEqual(await selectedColumns(), [1])
    checks.push(`${readonly ? 'readonly' : 'editable'}: header drag forward/reverse, shrink back to origin, whole-column copy, no accidental sort, release outside`)
    await header('extra').click()
    await header('id').click({ modifiers: ['Control'] })
    assert.deepEqual(await selectedColumns(), [0, 2])
    assert.equal(await page.evaluate(() => window.sortCalls || 0), 0)
    assert.equal(await copyKey(), '3\tnew\n1\tx\n2\tNULL')
    await header('extra').click({ button: 'right' })
    assert.equal(await page.getByRole('button', { name: '单元格操作' }).count(), 0)
    assert.deepEqual(await selectedColumns(), [0, 2])
    assert.equal(await commaData(), "3,'new',1,'x',2,NULL")
    await header('extra').click()
    await header('id').click({ modifiers: ['Shift'] })
    assert.deepEqual(await selectedColumns(), [0, 1, 2])
    await header('note').click({ modifiers: ['Control'] })
    assert.deepEqual(await selectedColumns(), [0, 2])
    await header('id').click({ modifiers: ['Control'] })
    await header('extra').click({ modifiers: ['Control'] })
    assert.deepEqual(await selectedColumns(), [])
    await page.evaluate(() => { window.copied = 'untouched' })
    assert.equal(await copyKey(), 'untouched')
    await header('note').click()
    await cell(0, 1).click({ button: 'right' })
    assert.deepEqual(await selectedColumns(), [1])
    assert.equal(await commaData(), "'draft','a''b',''")
    await cell(0, 2).click({ button: 'right' })
    assert.deepEqual(await selectedColumns(), [2])
    assert.equal(await commaData(), "'new','x',NULL")
    await header('extra').click({ button: 'right' })
    assert.deepEqual(await selectedColumns(), [2])
    await page.keyboard.press('Escape')
    await cell(0, 1).click()
    assert.deepEqual(await selectedColumns(), [])
    assert.equal(await copyKey(), "a'b")
    await page.getByRole('button', { name: '选中第 1 行', exact: true }).click()
    assert.equal(await copyKey(), "1\ta'b\tx")
    await cell(-1, 1).click()
    await cell(1, 2).click({ modifiers: ['Shift'] })
    assert.equal(await copyKey(), "draft\tnew\na'b\tx\n\"\"\tNULL")
    await drag(cell(1, 2), cell(-1, 1))
    assert.equal(await copyKey(), "draft\tnew\na'b\tx\n\"\"\tNULL")
    await drag(cell(-1, 1), cell(1, 2), true)
    assert.equal(await copyKey(), 'draft')
    assert.equal(await page.locator('td.is-cell-range').count(), 1)
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), '')
    const start = await cell(-1, 1).boundingBox(), end = await cell(1, 2).boundingBox()
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
    await page.mouse.down()
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 })
    await page.mouse.up()
    assert.equal(await copyKey(), "draft\tnew\na'b\tx\n\"\"\tNULL")
    await page.getByRole('button', { name: '排序 id', exact: true }).click()
    assert.equal(await page.evaluate(() => window.sortCalls), 1)
    assert.equal(await page.locator('th[data-col="0"]').getAttribute('aria-sort'), 'ascending')
    await header('note').click()
    await header('note').click({ button: 'right' })
    await page.evaluate(() => window.refreshResult())
    await page.waitForFunction(() => !document.querySelector('.db-grid-copy-menu') && !document.querySelector('th.is-column-selected'))
    await page.evaluate(() => { window.copied = 'reset' })
    assert.equal(await copyKey(), 'reset')
    await header('extra').click({ modifiers: ['Shift'] })
    assert.deepEqual(await selectedColumns(), [2])
    checks.push(`${readonly ? 'readonly' : 'editable'}: arbitrary columns, reverse Shift, toggle empty, clipboard, right click, independent sort, refresh reset`)

    if (!readonly) {
      await cell(0, 1).dblclick()
      await page.getByLabel('编辑 note', { exact: true }).fill('edited')
      await page.getByLabel('编辑 note', { exact: true }).press('Enter')
      await header('note').click()
      assert.equal(await copyKey(), 'draft\nedited\n""')
      await page.locator('.db-grid-scroll').press('Control+f')
      const search = page.getByRole('textbox', { name: '在当前结果中查找', exact: true })
      await search.fill('edited')
      await page.waitForFunction(() => document.querySelectorAll('.is-cell-match-current').length === 1)
      checks.push('editing commits and copying includes edited values; result search still finds edited cell')
    }

    // Drive real context-menu handlers at viewport corners and measure rendered popups.
    for (const dark of [false, true]) {
      if (dark) await page.locator('#theme').click()
      for (const [x, y] of [[10, 10], [1190, 10], [10, 790], [1190, 790], [530, 420]]) {
        await cell(0, 1).evaluate((node, point) => node.dispatchEvent(new MouseEvent('contextmenu', { clientX: point.x, clientY: point.y, bubbles: true, cancelable: true })), { x, y })
        const primary = page.getByRole('menu', { name: '结果复制菜单', exact: true })
        await page.getByRole('menuitem', { name: '逗号分隔', exact: true }).hover()
        const secondary = page.getByRole('menu', { name: '逗号分隔', exact: true })
        const a = await primary.boundingBox(), b = await secondary.boundingBox()
        const styles = await page.locator('.db-context-menu').evaluateAll(nodes => nodes.map(node => ({ style: node.getAttribute('style'), position: getComputedStyle(node).position, left: getComputedStyle(node).left, top: getComputedStyle(node).top })))
        await page.screenshot({ path: resolve(outdir, 'last-layout.png') })
        assert.equal(a.width, 208); assert.equal(b.width, 156)
        for (const box of [a, b]) {
          assert.ok(box.x >= 8 && box.x + box.width <= 1192, JSON.stringify({ x, y, a, b, styles }))
          assert.ok(box.y >= 8 && box.y + box.height <= 792)
          assert.ok(box.height <= 360)
        }
        assert.ok(b.x >= a.x + a.width + 6 || b.x + b.width + 6 <= a.x)
        await secondary.getByRole('menuitem', { name: '数据', exact: true }).hover()
        await page.waitForTimeout(180)
        assert.equal(await secondary.count(), 1)
        await page.screenshot({ path: resolve(outdir, `${readonly ? 'readonly' : 'editable'}-${dark ? 'dark' : 'light'}-${x}-${y}.png`) })
        await page.keyboard.press('Escape')
        assert.equal(await primary.count(), 0)
      }
    }
    await page.setViewportSize({ width: 320, height: 500 })
    await cell(0, 1).evaluate(node => node.dispatchEvent(new MouseEvent('contextmenu', { clientX: 300, clientY: 480, bubbles: true, cancelable: true })))
    await page.getByRole('menuitem', { name: '逗号分隔', exact: true }).hover()
    await page.waitForFunction(() => !!document.querySelector('.db-grid-copy-inline'))
    assert.equal(await page.locator('.db-grid-copy-fly').count(), 0)
    const narrow = await page.getByRole('menu', { name: '结果复制菜单', exact: true }).boundingBox()
    assert.ok(narrow.x >= 8 && narrow.x + narrow.width <= 312 && narrow.y + narrow.height <= 492)
    await page.screenshot({ path: resolve(outdir, `${readonly ? 'readonly' : 'editable'}-narrow.png`) })
    await page.locator('#theme').click()
    assert.equal(await page.locator('.db-grid-copy-menu').count(), 0)
    await page.setViewportSize({ width: 1200, height: 800 })
    await page.evaluate(() => window.emptyResult())
    await header('note').click()
    await header('note').click({ button: 'right' })
    await page.getByRole('menuitem', { name: '复制字段名', exact: true }).click()
    assert.equal(await page.evaluate(() => window.copied), 'note')
    checks.push(`${readonly ? 'readonly' : 'editable'}: light/dark corner and center popup geometry, hover gap, narrow inline, outside dismiss, empty-result field copy`)
    await page.close()
  }
  assert.deepEqual(pageErrors, [])
  const report = { status: 'PASS', evidence: 'actual QueryResultGrid components with controlled data and clipboard', checks, pageErrors }
  await writeFile(resolve(outdir, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'

const outdir = resolve('artifacts/ui/query-layout')
await mkdir(outdir, { recursive: true })
await build({
  stdin: {
    resolveDir: resolve('.'),
    sourcefile: 'query-layout-fixture.tsx',
    loader: 'tsx',
    contents: `
      import React, { useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import { SqlRunWorkspace } from './src/client/sql-run-workspace.tsx'
      import { QueryResultFrame } from './src/client/workspace/source/query-result-frame.tsx'
      import { QueryResultGrid } from './src/client/query-result-grid.tsx'
      import './src/client/style.css'

      const connection = {
        id: 'fixture', generation: 'g1', name: 'Fixture', dialect: 'mysql',
        environment: 'sit', database: 'app', live: true, health: 'ready',
      }
      const result = {
        columns: ['id', 'payload', 'status'],
        rows: Array.from({ length: 80 }, (_, i) => [
          String(i + 1),
          JSON.stringify({ index: i + 1, text: 'long value '.repeat(16) }),
          i % 2 ? 'ready' : 'pending',
        ]),
        truncated: false,
        elapsedMs: 12,
      }
      function Fixture() {
        const [sql, setSql] = useState('SELECT id, payload, status FROM demo')
        const [resultOpen, setResultOpen] = useState(true)
        const [ratio, setRatio] = useState(.5)
        const [pane, setPane] = useState('result')
        const [selected, setSelected] = useState()
        return <div className="db-workbench">
          <output id="fixture-ratio" hidden>{ratio}</output>
          <SqlRunWorkspace
            connection={connection}
            schema="app"
            sql={sql}
            onChange={setSql}
            onRun={() => {}}
            resultOpen={resultOpen}
            onResultOpenChange={setResultOpen}
            editorRatio={ratio}
            onRatioChange={setRatio}
            actions={{ save: false, explain: false, ai: false }}
            resultFrame={<QueryResultFrame
              pane={pane}
              onPaneChange={setPane}
              summary={<span>80 行 · 12 ms</span>}
              message={<div className="db-sql-step-log"><p>Fixture message</p></div>}
            >
              <QueryResultGrid
                result={result}
                readOnly
                allowInsert={false}
                primaryKeys={[]}
                changed={{}}
                draftRows={[]}
                selected={selected}
                onSelect={setSelected}
                onEditStart={() => {}}
                onEditCommit={() => {}}
                onEditCancel={() => {}}
                onRowSelect={row => setSelected({ row, col: 0 })}
                onContext={() => {}}
                detailColumn={selected ? result.columns[selected.col] : undefined}
                detailValue={selected ? result.rows[selected.row][selected.col] : undefined}
              />
            </QueryResultFrame>}
          />
        </div>
      }
      createRoot(document.getElementById('app')).render(<Fixture />)
    `,
  },
  bundle: true,
  format: 'esm',
  outdir,
  entryNames: 'fixture',
  assetNames: 'fixture',
})
await writeFile(resolve(outdir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/fixture.css"><style>html,body,#app{height:100%;margin:0}</style></head><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>')

const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname === '/' ? '/index.html' : new URL(request.url, 'http://localhost').pathname
  try {
    const body = await readFile(resolve(outdir, `.${path}`))
    response.writeHead(200, { 'Content-Type': path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : 'text/html' })
    response.end(body)
  } catch {
    response.writeHead(404)
    response.end()
  }
})
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
const url = `http://127.0.0.1:${server.address().port}/`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1200, height: 720 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))

try {
  await page.goto(url)
  await page.getByLabel('SQL 编辑器').waitFor()
  const editor = page.locator('.db-sql-editor-row')
  const grid = page.locator('.db-query-result-grid .db-grid-scroll')
  assert.ok((await editor.boundingBox()).height >= 96)
  assert.ok((await grid.boundingBox()).height >= 84)
  assert.ok(await page.getByRole('tab', { name: '结果' }).isVisible())
  assert.ok(await page.getByRole('tab', { name: '消息' }).isVisible())
  await page.locator('.db-data-grid tbody tr').evaluateAll(rows => rows.slice(2).forEach(row => row.remove()))
  const sparseBody = await page.locator('.db-query-result-body').boundingBox()
  const sparseFoot = await page.locator('.db-query-result-foot').boundingBox()
  assert.ok(Math.abs((sparseBody.y + sparseBody.height) - sparseFoot.y) <= 1, 'sparse results must fill the result track above its footer')
  await page.reload()
  await page.getByLabel('SQL 编辑器').waitFor()

  const gutter = page.locator('.db-pane-gutter-y.is-resizable')
  const before = (await editor.boundingBox()).height
  const rail = await gutter.boundingBox()
  await gutter.dispatchEvent('pointerdown', { pointerId: 1, button: 0, clientX: rail.x + 20, clientY: rail.y + rail.height / 2 })
  await page.evaluate(({ x, y }) => {
    window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, button: 0, clientX: x, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, button: 0, clientX: x, clientY: y }))
  }, { x: rail.x + 20, y: rail.y + 70 })
  const after = (await editor.boundingBox()).height
  const draggedRatio = await page.locator('#fixture-ratio').textContent()
  assert.ok(after > before, `dragging the blank splitter rail should grow the editor (${before} -> ${after}, ratio ${draggedRatio})`)

  await page.setViewportSize({ width: 768, height: 420 })
  await page.locator('.db-data-grid tbody td').nth(1).click()
  await page.getByRole('button', { name: '展开字段详情' }).click()
  assert.ok((await grid.boundingBox()).height >= 80)
  assert.ok(await grid.evaluate(node => node.scrollHeight > node.clientHeight))
  await grid.evaluate(node => { node.scrollTop = node.scrollHeight })
  assert.ok(await grid.evaluate(node => node.scrollTop > 0))
  await page.getByRole('button', { name: '收起字段详情' }).click()

  await page.getByRole('button', { name: '收起结果' }).click()
  assert.ok(await page.getByLabel('SQL 编辑器').isVisible())
  await page.getByRole('button', { name: '展开结果' }).click()
  assert.ok(await page.getByRole('tab', { name: '结果' }).isVisible())

  await page.getByRole('tab', { name: '消息' }).click()
  await page.getByText('Fixture message', { exact: true }).waitFor()
  const body = page.locator('.db-query-result-body')
  assert.ok((await body.boundingBox()).height > 0)
  const messageBody = await body.boundingBox()
  const messageFoot = await page.locator('.db-query-result-foot').boundingBox()
  assert.ok(Math.abs((messageBody.y + messageBody.height) - messageFoot.y) <= 1, 'message content must fill the result track above its footer')

  for (const width of [420, 768, 1200]) {
    await page.setViewportSize({ width, height: 600 })
    assert.ok(await page.locator('.db-workbench').evaluate(node => node.scrollWidth <= node.clientWidth + 1))
    await page.screenshot({ path: resolve('artifacts/ui', `query-layout-${width}.png`) })
  }
  assert.deepEqual(errors, [])
  const report = { status: 'PASS', checks: ['editor visible', 'split draggable', 'grid scrollable', 'dock bounded', 'message fills result', 'responsive widths'], pageErrors: errors }
  await writeFile(resolve('artifacts/ui/query-layout-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
  await new Promise(done => server.close(done))
}

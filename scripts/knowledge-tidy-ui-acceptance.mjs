import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const out = resolve('artifacts/ui/knowledge-tidy')
await mkdir(out, { recursive: true })
await build({
  stdin: {
    resolveDir: resolve('.'),
    loader: 'tsx',
    contents: `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import './src/client/style.css'
import { useWorkbenchTheme } from './src/client/workspace/parts/theme/use-workbench-theme.ts'
import { KnowledgeLibrary } from './src/client/workspace/knowledge/knowledge-library.tsx'
import { useKnowledgeTidy } from './src/client/workspace/knowledge/use-knowledge-tidy.ts'
const before = 'SELECT id FROM orders WHERE id = 1'
const after = 'SELECT id FROM orders WHERE id = 2'
const calls = []
let pending = true
const bridge = { templates: async (action, body) => {
  calls.push({ action, body })
  if (action === 'template-tidy-get') return pending ? { tidy: { id: 'review-batch', connectionId: 'c1', sourceId: 'mysql', createdAt: '2026-10-15T00:00:00.000Z', changes: [{
    id: 'a', kind: 'update', expectedVersion: 1, risk: 'executable-changed',
    archiveTargets: [{ id: 'duplicate', expectedVersion: 3, before: { title: '待归档订单经验', summary: '重复经验', tags: ['archive'], text: 'SELECT old_id FROM orders' } }],
    before: { title: '旧标题', summary: '旧说明', tags: ['old'], text: before },
    after: { title: '新标题', summary: '新说明', tags: ['new'], text: after },
  }] } } : { tidy: null }
  if (action === 'template-tidy-apply') { pending = false; return { applied: ['a'], failed: [], remaining: 0 } }
  return {}
} }
function App() {
  const theme = useWorkbenchTheme()
  const [items, setItems] = useState([{ id: 'row', title: '旧标题', summary: '旧说明', subtitle: 'mysql' }])
  const tidy = useKnowledgeTidy(bridge, { id: 'c1', generation: 'g1' }, true, 'template', () => setItems([{ id: 'row', title: '新标题', summary: '新说明', subtitle: 'mysql' }]))
  window.fixture = { calls }
  return <div className={'db-workbench' + (theme.dark ? ' db-dark' : '')} {...theme.attributes} style={{ ...theme.style, width: 1100, height: 720 }}>
    <KnowledgeLibrary sourceName="SQL" items={items} selectedId="" onSelect={() => {}} search="" onSearch={() => {}} title="" onTitle={() => {}} summary="" onSummary={() => {}} tags="" onTags={() => {}}
      onRun={() => {}} onSave={() => {}} onUse={() => {}} onArchive={() => {}} tidy={tidy} />
  </div>
}
createRoot(document.getElementById('app')).render(<App />)
`,
  },
  bundle: true,
  format: 'esm',
  outfile: resolve(out, 'fixture.js'),
})
const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>'
const server = createServer(async (req, res) => {
  const name = req.url === '/fixture.js' ? 'fixture.js' : req.url === '/fixture.css' ? 'fixture.css' : null
  res.setHeader('content-type', name?.endsWith('.js') ? 'application/javascript' : name?.endsWith('.css') ? 'text/css' : 'text/html')
  res.end(name ? await readFile(resolve(out, name)) : html)
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
try {
  await page.goto('http://127.0.0.1:' + server.address().port)
  await page.getByText('待审批 1 条').waitFor()
  await page.getByRole('button', { name: /新标题/ }).click()
  await page.getByRole('status').filter({ hasText: '可执行内容已变化' }).waitFor()
  await page.getByLabel('经验差异').waitFor()
  assert.equal(await page.locator('.db-nacos-diff .cm-changedText, .db-nacos-diff .cm-insertedText, .db-nacos-diff .cm-deletedText').count() > 0, true)
  assert.match(await page.locator('.db-nacos-diff').innerText(), /WHERE id = 2/)
  const archives = page.getByRole('region', { name: '同时归档的经验' })
  await archives.getByText('待归档订单经验 · v3').click()
  await archives.getByText('SELECT old_id FROM orders', { exact: true }).waitFor()
  await page.getByRole('button', { name: '通过这条' }).click()
  await page.getByText('已通过 1 条。').waitFor()
  await page.getByText('待审批 1 条').waitFor({ state: 'hidden' })
  await page.locator('.db-template-list-main', { hasText: '新标题' }).waitFor()
  assert.equal(await page.getByText('旧标题').count(), 0)
  assert.equal(await page.evaluate(() => window.fixture.calls.some(call => call.action === 'template-tidy-apply' && call.body.batchId === 'review-batch')), true)
  assert.deepEqual(errors, [])
  console.log('knowledge tidy approval: diff visible, approve updates the list')
} finally {
  await browser.close()
  server.close()
}

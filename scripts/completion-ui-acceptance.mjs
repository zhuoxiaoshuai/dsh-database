import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const fixture = `
  import React, { useState } from 'react'
  import { createRoot } from 'react-dom/client'
  import { EditorView } from '@codemirror/view'
  import { completionStatus, currentCompletions, selectedCompletionIndex } from '@codemirror/autocomplete'
  window.completionProbe = () => { const view = EditorView.findFromDOM(document.querySelector('.cm-editor')); return { composing: view.composing, focused: view.hasFocus, status: completionStatus(view.state), selected: selectedCompletionIndex(view.state), options: currentCompletions(view.state).map(item => item.label) } }
  import { SqlEditor } from './src/client/editor.tsx'
  import { SchemaCache } from './src/client/schema/schema-cache.ts'
  import { RedisCommandEditor } from './src/client/redis/command-editor.tsx'
  import { redisParameterHint } from './src/client/redis/completion.ts'

  const cache = new SchemaCache(async (_connection, request) => {
    await new Promise(resolve => setTimeout(resolve, 80))
    if (request.kind === 'tables') return { items: [{ name: 'users', kind: 'BASE TABLE' }, { name: 'user_stats', kind: 'BASE TABLE' }, { name: 'orders', kind: 'BASE TABLE' }, { name: '用户', kind: 'BASE TABLE', comment: '客户资料' }, { name: 'cold_names', kind: 'BASE TABLE' }, { name: 'cold_closed', kind: 'BASE TABLE' }], more: false, collectedAt: '', source: 'fixture' }
    if (request.table?.startsWith('cold_')) await new Promise(resolve => { window[request.table] = resolve })
    return { columns: [{ name: '姓名', type: 'varchar', comment: '客户名称' }, { name: 'name', type: 'varchar' }, { name: 'id', type: 'integer' }, { name: 'username', type: 'varchar' }], primaryKeys: ['id'], collectedAt: '', source: 'fixture' }
  }, { emitCoalesceMs: 0, prewarmTableLimit: 0, schedule: task => task() })
  const redisKeys = ['cache:local', 'space key']

  function App() {
    const [dialect, setDialect] = useState('mysql')
    const [value, setValue] = useState('')
    const [command, setCommand] = useState('PING')
    const [cursor, setCursor] = useState(4)
    const [runCount, setRunCount] = useState(0)
    const [lastRun, setLastRun] = useState('')
    const [keyStatus, setKeyStatus] = useState('partial')
    const [lookups, setLookups] = useState(0)
    const connection = { id: dialect, generation: 'g1', name: dialect, dialect, environment: 'sit', database: 'app', live: true }
    return <div className="db-workbench" style={{height:'100vh'}}>
      <select aria-label="数据库类型" value={dialect} onChange={event => { setDialect(event.target.value); setValue('') }}><option value="mysql">MySQL</option><option value="oracle">Oracle</option><option value="redis">Redis</option></select>
      <output id="run-count">{runCount}</output>
      <output id="last-run">{lastRun}</output>
      <output id="key-status">{keyStatus}</output><output id="key-lookups">{lookups}</output>
      <div style={{height:320}}>{dialect === 'redis'
        ? <><RedisCommandEditor value={command} onChange={setCommand} onCursorChange={setCursor} onRun={text => { setLastRun(text); setRunCount(n => n + 1) }} keys={redisKeys} identity="redis:g1" suggestKeys={async (prefix, signal) => { setLookups(n => n + 1); await new Promise(resolve => setTimeout(resolve, 40)); if (signal.aborted) throw Error('cancelled'); return { keys: ['cache:remote'], complete: false, scannedPages: 5 } }} onKeySuggestionStatus={setKeyStatus} /><p id="redis-hint">{redisParameterHint(command.slice(0, cursor))}</p></>
        : <SqlEditor key={dialect} value={value} dialect={dialect} schema="app" connection={connection} cache={cache} onChange={setValue} onRun={() => setRunCount(n => n + 1)} />}</div>
    </div>
  }
  createRoot(document.getElementById('app')).render(<App />)
`
const built = await build({ stdin: { contents: fixture, resolveDir: resolve('.'), sourcefile: 'completion-fixture.tsx', loader: 'tsx' }, bundle: true, format: 'esm', platform: 'browser', write: false })
const js = built.outputFiles[0]?.text
assert.ok(js)
const css = await readFile('src/client/style.css', 'utf8')
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname
  const body = path === '/' ? '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><style>html,body,#app{height:100%;margin:0}</style></head><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>' : path === '/fixture.js' ? js : path === '/style.css' ? css : undefined
  response.writeHead(body === undefined ? 404 : 200, { 'Content-Type': path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' })
  response.end(body)
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
let browser
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1050, height: 700 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  const editor = page.getByLabel('SQL 编辑器')
  await editor.waitFor()
  for (const dialect of ['mysql', 'oracle']) {
    await page.getByLabel('数据库类型').selectOption(dialect)
    await editor.click()
    await page.keyboard.type('SELECT * FROM us')
    await page.waitForTimeout(250)
    await page.keyboard.press('Control+Shift+Space')
    const option = page.locator('.cm-tooltip-autocomplete li').filter({ hasText: 'users' }).first()
    await option.waitFor({ timeout: 3000 }).catch(async error => {
      console.error('completion debug', dialect, await editor.textContent(), await page.locator('.cm-tooltip').allTextContents(), errors)
      throw error
    })
    await page.waitForFunction(() => window.completionProbe().status === 'active')
    const firstSelection = await page.evaluate(() => window.completionProbe().selected)
    await page.keyboard.press('ArrowDown')
    assert.notEqual(await page.evaluate(() => window.completionProbe().selected), firstSelection)
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    assert.match(await editor.textContent(), /FROM users/)
    await editor.click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('SELECT u. FROM users u')
    await page.waitForTimeout(250)
    await page.keyboard.press('Home')
    for (let i = 0; i < 'SELECT u.'.length; i++) await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Control+Shift+Space')
    const column = page.locator('.cm-tooltip-autocomplete li').filter({ hasText: 'username' }).first()
    await column.waitFor()
    await column.click()
    assert.match(await editor.textContent(), /SELECT u\.username FROM users u/)
    await page.keyboard.press('ControlOrMeta+Enter')
    assert.equal(Number(await page.locator('#run-count').textContent()), dialect === 'mysql' ? 1 : 2)
    await editor.click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('SELECT * FROM us')
    await option.waitFor()
    await page.getByLabel('数据库类型').click()
    await option.waitFor({ state: 'hidden' })
  }
  await page.getByLabel('数据库类型').selectOption('mysql')
  const typeSql = async text => { await editor.click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(text) }
  await typeSql('SELECT * FROM 用户 WHERE 客户')
  await page.locator('.cm-tooltip-autocomplete li').filter({ hasText: '姓名' }).waitFor()
  await page.waitForFunction(() => window.completionProbe().status === 'active')
  await page.keyboard.press('Enter')
  assert.match(await editor.textContent(), /WHERE 姓名$/)
  await typeSql('SELECT * FROM 用户 WHERE name')
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Control+Shift+Space')
  await page.waitForFunction(() => window.completionProbe().status === 'active')
  await page.keyboard.press('Enter')
  assert.match(await editor.textContent(), /WHERE name$/)
  await typeSql('SELECT * FROM cold_names WHERE na')
  await page.waitForFunction(() => window.cold_names)
  await page.evaluate(() => window.cold_names())
  await page.locator('.cm-tooltip-autocomplete li').filter({ hasText: /^name/ }).first().waitFor()
  await page.waitForFunction(() => window.completionProbe().status === 'active')
  await page.keyboard.press('Enter'); assert.match(await editor.textContent(), /WHERE name$/)
  await typeSql('SELECT * FROM cold_closed WHERE na')
  await page.waitForFunction(() => window.cold_closed)
  await page.keyboard.press('Escape'); await page.evaluate(() => window.cold_closed())
  await page.waitForTimeout(150)
  assert.equal(await page.locator('.cm-tooltip-autocomplete:visible').count(), 0)
  await typeSql('SELECT * FROM us')
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
  await editor.click()
  await page.keyboard.type('SELECT * FROM us')
  await page.keyboard.press('Control+Shift+Space')
  await page.locator('.cm-tooltip-autocomplete li').filter({ hasText: 'users' }).first().waitFor()
  assert.ok(await page.locator('.cm-tooltip-autocomplete').evaluate(node => node.classList.contains('db-dark') || getComputedStyle(node).colorScheme === 'dark'))
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: '测', selectionStart: 1, selectionEnd: 1 })
  await page.keyboard.press('Enter')
  assert.doesNotMatch(await editor.textContent(), /FROM users$/)
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
  await cdp.detach()
  await page.getByLabel('数据库类型').selectOption('redis')
  const redis = page.getByLabel('Redis 命令')
  await redis.waitFor()
  await redis.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('PI')
  const ping = page.locator('.cm-tooltip-autocomplete li').filter({ hasText: 'PING' }).first()
  await ping.waitFor()
  assert.match(await ping.textContent(), /检查当前命令连接/)
  await page.keyboard.press('ArrowDown')
  await page.locator('.cm-tooltip-autocomplete .cm-completionInfo').waitFor()
  assert.match(await page.locator('.cm-tooltip-autocomplete .cm-completionInfo').textContent(), /用途：.*参数：.*返回：.*示例：/s)
  await page.keyboard.press('Enter')
  assert.equal(await redis.textContent(), 'PING')
  assert.equal(Number(await page.locator('#run-count').textContent()), 2, 'accepting a completion must not execute the command')
  await page.keyboard.press('ControlOrMeta+Enter')
  assert.equal(await page.locator('#last-run').textContent(), 'PING')
  assert.equal(Number(await page.locator('#run-count').textContent()), 3)
  await redis.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('CONFIG GE')
  await page.locator('.cm-tooltip-autocomplete li').filter({ hasText: 'GET' }).first().click()
  assert.equal(await redis.textContent(), 'CONFIG GET')
  await redis.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('SET key value N')
  await page.locator('.cm-tooltip-autocomplete li').filter({ hasText: 'NX' }).first().waitFor()
  await page.keyboard.press('Enter')
  assert.equal(await redis.textContent(), 'SET key value NX')
  await redis.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('GET ')
  await page.keyboard.press('Control+Shift+Space')
  assert.match(await page.locator('#redis-hint').textContent(), /读取一个 String Key/)
  assert.equal(await page.locator('#key-lookups').textContent(), '0', 'empty prefix must not scan remotely')
  await page.keyboard.type('ca')
  await page.locator('.cm-tooltip-autocomplete li').filter({ hasText: 'cache:local' }).first().waitFor()
  await page.locator('.cm-tooltip-autocomplete li').filter({ hasText: 'cache:remote' }).first().waitFor({ timeout: 5000 }).catch(async error => { console.error('redis suggestion debug', await redis.textContent(), await page.locator('#key-status').textContent(), await page.locator('#key-lookups').textContent(), await page.locator('.cm-tooltip-autocomplete li').allTextContents(), errors); throw error })
  assert.equal(await page.locator('#key-status').textContent(), 'partial')
  await page.locator('.cm-tooltip-autocomplete li').filter({ hasText: 'cache:remote' }).first().click()
  assert.equal(await redis.textContent(), 'GET cache:remote')
  assert.equal(Number(await page.locator('#run-count').textContent()), 3, 'accepting a Key must not execute the command')
  assert.deepEqual(errors, [])
  console.log('Completion browser acceptance passed: MySQL, Oracle and Redis; keyboard, mouse, IME, dark theme, blur, parameter hints and execution shortcut.')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}

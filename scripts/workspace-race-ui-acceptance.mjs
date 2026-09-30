import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const outdir = resolve('artifacts/ui/workspace-races')
await mkdir(outdir, { recursive: true })
await build({ stdin: { resolveDir: resolve('.'), sourcefile: 'workspace-races.tsx', loader: 'tsx', contents: `
  import React, { useState } from 'react'
  import { createRoot } from 'react-dom/client'
  import { useExecutionDocument } from './src/client/workspace/source/use-execution-document.ts'
  import { updateExecutionDocument } from './src/shared/execution-document.ts'
  import { useKnowledgeLibrary } from './src/client/workspace/knowledge/use-knowledge-library.ts'
  const gates = new Set()
  const waiting = []
  let serverDocument = { sourceId: 'redis', text: '', context: {}, revision: 1, controller: 'ai' }
  let items = []
  const defer = (action, work) => gates.has(action) ? new Promise((resolve, reject) => waiting.push({ action, resolve: () => { try { resolve(work()) } catch (e) { reject(e) } }, reject: () => reject(new Error('fixture failure')) })) : Promise.resolve().then(work)
  let eventResolve
  const bridge = {
    mode: 'host', connections: [], tables: () => [], execute: async () => ({}),
    executions: (action, body, signal) => {
      if (action === 'execution-wait') return new Promise((resolve, reject) => { eventResolve = resolve; signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }) })
      return defer(action, () => {
        if (action === 'execution-document-get') return { document: { ...serverDocument } }
        if (action === 'execution-document-update') { serverDocument = updateExecutionDocument(serverDocument, body.text, 'user', body.revision, body.context); return { document: { ...serverDocument } } }
        if (action === 'execution-document-control') { serverDocument = { ...serverDocument, controller: body.controller, revision: serverDocument.revision + 1 }; return { document: { ...serverDocument } } }
        if (action === 'execution-document-run') return { operation: serverDocument.text }
        return {}
      })
    },
    templates: (action, body) => defer(action, () => {
      if (action === 'knowledge-search') return { items: [...items] }
      if (action === 'knowledge-publish') { const item = { id: body.id || 'item-' + (items.length + 1), sourceId: 'redis', connectionId: body.connectionId, text: body.text, title: body.title, summary: body.summary, tags: body.tags, version: 1 }; items = [item, ...items.filter(x => x.id !== item.id)]; return item }
      if (action === 'knowledge-archive') { items = items.filter(x => x.id !== body.id); return {} }
      return {}
    }),
  }
  window.fixture = { gates, waiting, release(action) { const i = waiting.findIndex(x => x.action === action); if (i < 0) throw Error('no pending ' + action); waiting.splice(i, 1)[0].resolve() }, reject(action) { const i = waiting.findIndex(x => x.action === action); if (i < 0) throw Error('no pending ' + action); waiting.splice(i, 1)[0].reject() }, pushEvent(event) { eventResolve?.({ revision: Date.now(), items: [], events: [event] }) }, setServer(text) { serverDocument = { ...serverDocument, text, revision: serverDocument.revision + 1 } }, serverController: () => serverDocument.controller }
  function App() {
    const [generation, setGeneration] = useState('g1')
    const [database, setDatabase] = useState('0')
    const connection = { id: 'redis-race', generation, dialect: 'redis', live: true, name: 'Race', environment: 'sit' }
    const doc = useExecutionDocument(bridge, connection, { database }, database)
    const knowledge = useKnowledgeLibrary(bridge, connection, true, async text => defer('knowledge-run', () => ({ text })), () => {}, database)
    window.fixture.setDatabase = setDatabase; window.fixture.serverDocument = () => serverDocument
    window.fixture.doc = doc; window.fixture.knowledge = knowledge; window.fixture.reconnect = () => setGeneration(x => x === 'g1' ? 'g2' : 'g1')
    return <div><textarea id="ai" value={doc.text} onChange={e => doc.edit(e.target.value)} /><span id="ai-state">{JSON.stringify({ text: doc.text, busy: doc.busy, error: doc.error, controller: doc.document.controller, reply: doc.reply })}</span>
      <textarea id="knowledge" value={knowledge.text} onChange={e => knowledge.setText(e.target.value)} /><span id="knowledge-state">{JSON.stringify({ text: knowledge.text, busy: knowledge.busy, error: knowledge.error, runError: knowledge.runError, selectedId: knowledge.selectedId, result: knowledge.result })}</span></div>
  }
  const root = createRoot(document.getElementById('app')); root.render(<App />); window.fixture.unmount = () => root.unmount()
` }, bundle: true, format: 'esm', outdir, entryNames: 'fixture' })
await writeFile(resolve(outdir, 'index.html'), '<!doctype html><div id="app"></div><script type="module" src="/fixture.js"></script>')
const server = createServer(async (request, response) => {
  const path = request.url === '/fixture.js' ? 'fixture.js' : 'index.html'
  response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/html')
  response.end(await readFile(resolve(outdir, path)))
})
await new Promise(ok => server.listen(0, '127.0.0.1', ok))
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage()
page.setDefaultTimeout(6000)
const errors = []
page.on('pageerror', error => errors.push(error.message))
const pending = action => page.waitForFunction(name => window.fixture?.waiting.some(x => x.action === name), action)
const state = async id => JSON.parse(await page.locator(id).textContent())
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.waitForFunction(() => window.fixture?.doc && window.fixture?.knowledge)
  await page.waitForFunction(() => window.fixture.serverDocument().context.database === '0')
  await page.evaluate(() => window.fixture.gates.add('execution-document-update'))
  console.log('race-stage: late-save')
  await page.locator('#ai').fill('GET a')
  await pending('execution-document-update')
  await page.locator('#ai').fill('GET b')
  await page.evaluate(() => window.fixture.release('execution-document-update'))
  await pending('execution-document-update')
  assert.equal((await state('#ai-state')).text, 'GET b', 'late save A must not replace edit B')
  await page.evaluate(() => window.fixture.release('execution-document-update'))
  await page.waitForFunction(() => window.fixture.doc.document.text === 'GET b')
  await page.evaluate(() => { window.fixture.gates.delete('execution-document-update'); window.fixture.gates.add('execution-document-control') })
  console.log('race-stage: control')
  await page.evaluate(() => { void window.fixture.doc.run() })
  await pending('execution-document-control')
  await page.locator('#ai').fill('GET c')
  await page.evaluate(() => window.fixture.release('execution-document-control'))
  await page.waitForFunction(() => window.fixture.doc.error.includes('内容已变化'))
  assert.equal((await state('#ai-state')).reply, undefined, 'changed text must not receive old run result')
  await page.evaluate(() => window.fixture.gates.delete('execution-document-control'))
  await page.waitForFunction(() => window.fixture.doc.document.text === 'GET c')
  await page.evaluate(() => window.fixture.gates.add('execution-document-control'))
  await page.evaluate(() => { void window.fixture.doc.returnToAi() })
  await pending('execution-document-control')
  await page.locator('#ai').fill('GET d')
  await page.evaluate(() => { window.fixture.gates.delete('execution-document-control'); window.fixture.release('execution-document-control') })
  await page.waitForFunction(() => window.fixture.serverController() === 'user' && window.fixture.doc.document.text === 'GET d')
  await page.evaluate(() => window.fixture.gates.add('knowledge-publish'))
  console.log('race-stage: knowledge')
  await page.locator('#knowledge').fill('GET old')
  await page.evaluate(() => { void window.fixture.knowledge.save() })
  await pending('knowledge-publish')
  await page.locator('#knowledge').fill('GET new')
  await page.evaluate(() => window.fixture.knowledge.select(''))
  await page.evaluate(() => window.fixture.release('knowledge-publish'))
  assert.equal((await state('#knowledge-state')).selectedId, '', 'late save must not select old draft')
  await page.evaluate(() => { window.fixture.gates.delete('knowledge-publish'); window.fixture.gates.add('execution-document-get') })
  console.log('race-stage: reconnect-load')
  await page.evaluate(() => window.fixture.reconnect())
  await pending('execution-document-get')
  await page.locator('#ai').fill('GET current')
  await page.evaluate(() => window.fixture.release('execution-document-get'))
  assert.equal((await state('#ai-state')).text, 'GET current', 'late load must not replace local edit')
  await page.evaluate(() => window.fixture.gates.delete('execution-document-get'))
  await page.evaluate(() => { while (window.fixture.waiting.some(x => x.action === 'execution-document-get')) window.fixture.release('execution-document-get') })
  await page.waitForFunction(() => !window.fixture.doc.error && window.fixture.doc.document.text === 'GET current')
  await page.evaluate(() => window.fixture.gates.add('execution-document-run'))
  console.log('race-stage: reconnect-run')
  await page.evaluate(() => { void window.fixture.doc.run() })
  await pending('execution-document-run')
  await page.evaluate(() => window.fixture.reconnect())
  await page.waitForFunction(() => window.fixture.doc.busy === false)
  await page.evaluate(() => window.fixture.release('execution-document-run'))
  assert.equal((await state('#ai-state')).busy, false, 'old run must not leave new generation busy')
  await page.evaluate(() => window.fixture.pushEvent({ type: 'EXECUTION_DOCUMENT_CHANGED', connectionId: 'redis-race', generation: 'g2',
    document: { sourceId: 'redis', text: 'STALE', context: {}, revision: 999, controller: 'ai' } }))
  assert.notEqual((await state('#ai-state')).text, 'STALE', 'old generation event must be ignored')
  await page.evaluate(() => window.fixture.gates.add('knowledge-run'))
  await page.locator('#knowledge').fill('GET race')
  await page.evaluate(() => { void window.fixture.knowledge.tryRun() })
  await pending('knowledge-run')
  await page.evaluate(() => window.fixture.reconnect())
  await page.evaluate(() => window.fixture.release('knowledge-run'))
  await page.waitForFunction(() => window.fixture.knowledge.busy === false)
  assert.equal((await state('#knowledge-state')).result, undefined, 'old trial result must not enter new generation')
  await page.evaluate(() => { window.fixture.gates.delete('knowledge-run'); window.fixture.gates.add('knowledge-publish') })
  await page.locator('#knowledge').fill('GET error')
  await page.evaluate(() => { void window.fixture.knowledge.save() })
  await pending('knowledge-publish')
  await page.evaluate(() => window.fixture.reject('knowledge-publish'))
  await page.waitForFunction(() => window.fixture.knowledge.error.includes('fixture failure'))
  await page.evaluate(() => { window.fixture.gates.delete('knowledge-publish'); window.fixture.gates.add('knowledge-run') })
  await page.locator('#knowledge').fill('GET draft-a')
  await page.evaluate(() => { void window.fixture.knowledge.tryRun() })
  await pending('knowledge-run')
  await page.evaluate(() => window.fixture.knowledge.select(''))
  await page.locator('#knowledge').fill('GET draft-b')
  await page.evaluate(() => window.fixture.reject('knowledge-run'))
  await page.waitForFunction(() => !window.fixture.knowledge.busy)
  assert.equal((await state('#knowledge-state')).runError, '', 'late trial failure must not contaminate the next draft')
  await page.evaluate(() => { window.fixture.gates.delete('knowledge-run'); window.fixture.gates.add('execution-document-run') })
  await page.evaluate(() => { void window.fixture.doc.run() })
  await pending('execution-document-run')
  const beforeSwitch = await page.evaluate(() => window.fixture.doc.text)
  await page.evaluate(() => window.fixture.setDatabase('1'))
  await page.waitForFunction(() => window.fixture.serverDocument().context.database === '1')
  await page.evaluate(() => window.fixture.release('execution-document-run'))
  assert.equal((await state('#ai-state')).text, beforeSwitch, 'target switch preserves draft text')
  assert.equal((await state('#ai-state')).reply, undefined, 'old target result must be discarded')
  await page.evaluate(() => { window.fixture.gates.delete('execution-document-run'); window.fixture.gates.add('execution-document-update') })
  await page.evaluate(() => window.fixture.setDatabase('2'))
  await pending('execution-document-update')
  await page.evaluate(() => window.fixture.reject('execution-document-update'))
  await page.waitForFunction(() => window.fixture.doc.error.includes('fixture failure'))
  assert.equal((await state('#ai-state')).text, beforeSwitch, 'failed target save preserves draft')
  await page.evaluate(() => { window.fixture.gates.delete('execution-document-update'); window.fixture.doc.retrySave() })
  await page.waitForFunction(() => window.fixture.serverDocument().context.database === '2' && !window.fixture.doc.error)
  await page.evaluate(() => window.fixture.gates.add('execution-document-update'))
  await page.locator('#ai').fill('GET unmount-a')
  await pending('execution-document-update')
  await page.locator('#ai').fill('GET unmount-b')
  await page.evaluate(() => { window.fixture.unmount(); window.fixture.release('execution-document-update') })
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => window.fixture.waiting.filter(x => x.action === 'execution-document-update').length), 0, 'unmounted hook must not dispatch queued save')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'PASS', checks: ['mounted hooks', 'late save', 'edit during control', 'edit during return-to-AI', 'knowledge draft switch', 'late load', 'reconnect during run', 'stale event', 'trial during reconnect', 'late trial error', 'context switch during run', 'context save failure and retry', 'visible error', 'unmount queue'], pageErrors: errors }))
} finally {
  await browser.close()
  await new Promise(ok => server.close(ok))
}

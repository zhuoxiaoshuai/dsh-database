import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { SqlTemplateStore } from '../src/host/sql-template-store.ts'
import { KnowledgeService } from '../src/host/knowledge-service.ts'

const out = resolve('artifacts/ui/knowledge-concurrency')
await mkdir(out, { recursive: true })
const store = new SqlTemplateStore(await mkdtemp(resolve(out, 'store-')))
const service = new KnowledgeService(store)
const sqlSources = new Set(['mysql', 'oracle'])
const sources = ['mysql', 'oracle', 'redis', 'kafka']
const originals = {}
for (const sourceId of sources) {
  const connectionId = `review-${sourceId}`
  originals[sourceId] = sqlSources.has(sourceId)
    ? await store.publish({ dialect: sourceId, connectionId, action: 'create', sql: 'SELECT id FROM orders', title: 'Original' })
    : store.publishKnowledge({ sourceId, connectionId, text: sourceId === 'redis' ? 'GET old' : 'TOPICS', title: 'Original' })
}
await store.whenIdle()
const calls = []
await build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {useKnowledgeLibrary} from './src/client/workspace/knowledge/use-knowledge-library.ts';
import {useSqlKnowledge} from './src/client/sql/use-sql-knowledge.tsx';
const sourceId=new URLSearchParams(location.search).get('source');
const connection={id:'review-'+sourceId,generation:'g1',dialect:sourceId,live:false,environment:'sit'};
const bridge={templates:async(action,body)=>{const response=await fetch('/api',{method:'POST',body:JSON.stringify({sourceId,action,...body})});const data=await response.json();if(!response.ok)throw Error(data.error);return data;}};
function Controls({view,active,setActive}){window.current=view;return <>
 <button onClick={()=>setActive(value=>!value)}>toggle tab</button>
 <div hidden={!active}><button onClick={()=>view.select(view.items[0]?.id)}>select</button><button onClick={()=>view.save()}>save</button>
 <button onClick={()=>view.tidy.approve()}>approve</button><button onClick={()=>view.setSearch('absent')}>filter out</button><button onClick={()=>view.setSearch('')}>clear filter</button>
 <input aria-label="title" value={view.title} onChange={event=>view.setTitle(event.target.value)}/><textarea aria-label="draft" readOnly value={view.text}/>
 <span id="selected">{view.selectedId}</span><span id="count">{view.items.length}</span><span id="pending">{view.tidy.changes.length}</span><span id="error">{view.error}</span><span id="busy">{String(view.busy)}</span></div></>}
function Command(){const [active,setActive]=useState(true);const view=useKnowledgeLibrary(bridge,connection,active,async()=>({}),()=>{});return <Controls {...{view,active,setActive}}/>}
function Sql(){const [active,setActive]=useState(true);const props=useSqlKnowledge({bridge,connection,active,onClose:()=>{}});const view={...props,text:'SQL draft',select:props.onSelect,save:props.onSave,setTitle:props.onTitle,setSearch:props.onSearch};return <Controls {...{view,active,setActive}}/>}
createRoot(document.getElementById('app')).render(['mysql','oracle'].includes(sourceId)?<Sql/>:<Command/>);
` }, bundle: true, format: 'esm', outfile: resolve(out, 'fixture.js') })
const server = createServer(async (request, response) => {
  try {
    if (request.method === 'POST') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const { sourceId } = body, connectionId = `review-${sourceId}`
      calls.push(structuredClone(body))
      let result
      if (body.action === 'fixture-propose') {
        const item = sqlSources.has(sourceId) ? store.search('', sourceId, connectionId)[0] : store.searchKnowledge(sourceId, connectionId)[0]
        const sql = sqlSources.has(sourceId) ? 'SELECT id, name FROM orders' : sourceId === 'redis' ? 'GET approved' : 'GROUPS'
        result = store.proposeTidy({ sourceId, connectionId, changes: [{ id: item.id, kind: 'update', title: body.metadataOnly ? 'Approved metadata' : 'Approved', ...(body.metadataOnly ? {} : { sql }) }] })
      } else result = await service.dispatch(sourceId, connectionId, body)
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result)); return
    }
    response.setHeader('Content-Type', request.url.startsWith('/fixture.js') ? 'application/javascript' : 'text/html')
    response.end(request.url.startsWith('/fixture.js') ? await readFile(resolve(out, 'fixture.js')) : '<div id="app"></div><script type="module" src="/fixture.js"></script>')
  } catch (error) { response.writeHead(409, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message })) }
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const findings = [], errors = []
try {
  for (const sourceId of sources) {
    const page = await browser.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}/?source=${sourceId}`)
    await page.waitForFunction(() => window.current?.items.length === 1)
    await page.getByRole('button', { name: 'select', exact: true }).click()
    await page.waitForFunction(() => window.current.title === 'Original')
    const originalId = originals[sourceId].id
    await page.getByRole('button', { name: 'toggle tab' }).click()
    await page.request.post(`http://127.0.0.1:${server.address().port}/api`, { data: { sourceId, action: 'fixture-propose' } })
    await page.getByRole('button', { name: 'toggle tab' }).click()
    await page.waitForFunction(() => window.current.tidy.changes.length === 1)
    findings.push(`${sourceId}: pending proposal refreshed on tab revisit`)
    await page.getByRole('button', { name: 'approve', exact: true }).click()
    await page.waitForFunction(() => !window.current.tidy.busy && window.current.tidy.changes.length === 0 && window.current.items[0]?.title === 'Approved')
    assert.equal(await page.getByLabel('title').inputValue(), 'Original', 'existing draft stays available')
    // Filtering the refreshed list must not turn the selected draft into a new item.
    await page.getByRole('button', { name: 'filter out' }).click()
    await page.waitForFunction(() => window.current.items.length === 0)
    await page.getByRole('button', { name: 'save', exact: true }).click()
    await page.waitForFunction(() => /已被其他人更新|知识条目已更新/.test(window.current.error))
    const publish = calls.filter(call => call.sourceId === sourceId && /^(template|knowledge)-publish$/.test(call.action)).at(-1)
    assert.equal(publish.expectedVersion, 1)
    assert.equal(publish.targetId ?? publish.id, originalId)
    if (sqlSources.has(sourceId)) { assert.equal(publish.publishAction, 'newVersion'); assert.equal(publish.expectedSnapshot.title, 'Original') }
    assert.equal(await page.getByLabel('title').inputValue(), 'Original')
    findings.push(`${sourceId}: stale filtered draft rejected with original base and content preserved`)
    {
      await page.getByRole('button', { name: 'clear filter' }).click()
      await page.waitForFunction(() => window.current.items.length === 1)
      await page.getByRole('button', { name: 'select', exact: true }).click()
      await page.waitForFunction(() => window.current.title === 'Approved')
      await page.getByLabel('title').fill('User edit')
      await page.getByRole('button', { name: 'save', exact: true }).click()
      await page.waitForFunction(() => !window.current.busy && window.current.items[0]?.title === 'User edit')
      assert.equal(calls.filter(call => call.sourceId === sourceId && /^(template|knowledge)-publish$/.test(call.action)).at(-1).expectedVersion, 2)
      await page.getByLabel('title').fill('Next edit')
      await page.getByRole('button', { name: 'save', exact: true }).click()
      await page.waitForFunction(() => !window.current.busy && window.current.items[0]?.title === 'Next edit')
      assert.equal(calls.filter(call => call.sourceId === sourceId && /^(template|knowledge)-publish$/.test(call.action)).at(-1).expectedVersion, 3)
      findings.push(`${sourceId}: explicit reload and repeated save advance the editor base`)
    }
    if (sqlSources.has(sourceId)) {
      await page.getByRole('button', { name: 'toggle tab' }).click()
      await page.request.post(`http://127.0.0.1:${server.address().port}/api`, { data: { sourceId, action: 'fixture-propose', metadataOnly: true } })
      await page.getByRole('button', { name: 'toggle tab' }).click()
      await page.waitForFunction(() => window.current.tidy.changes.length === 1)
      await page.getByRole('button', { name: 'approve', exact: true }).click()
      await page.waitForFunction(() => !window.current.tidy.busy && window.current.items[0]?.title === 'Approved metadata')
      await page.getByRole('button', { name: 'save', exact: true }).click()
      await page.waitForFunction(() => /已被其他人更新/.test(window.current.error))
      assert.equal(await page.getByLabel('title').inputValue(), 'Next edit')
      await page.getByRole('button', { name: 'select', exact: true }).click()
      await page.waitForFunction(() => window.current.title === 'Approved metadata' && !window.current.error)
      await page.getByLabel('title').fill('After metadata reload')
      await page.getByRole('button', { name: 'save', exact: true }).click()
      await page.waitForFunction(() => !window.current.busy && window.current.items[0]?.title === 'After metadata reload')
      findings.push(`${sourceId}: metadata-only approval rejects old snapshot; explicit reselect reloads same ID and can save`)
    }
    await page.close()
  }
  assert.deepEqual(errors, [])
  const report = { status: 'PASS', scope: 'production Hooks and KnowledgeService/SqlTemplateStore over local HTTP; no external services', findings, pageErrors: errors }
  await writeFile(resolve(out, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
} finally { await browser.close(); await new Promise(done => server.close(done)) }

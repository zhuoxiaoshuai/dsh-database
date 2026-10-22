import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { SqlTemplateStore } from '../src/host/sql-template-store.ts'
import { KnowledgeService } from '../src/host/knowledge-service.ts'

// Actual Hooks, production metadata fields and durable Host stores; only timing/failures are controlled.
const out = resolve('artifacts/ui/knowledge-async')
await mkdir(out, { recursive: true })
const store = new SqlTemplateStore(await mkdtemp(resolve(out, 'store-'))), service = new KnowledgeService(store)
const sqlSources = new Set(['mysql', 'oracle']), sources = ['mysql', 'oracle', 'redis', 'kafka']
const calls = [], evidence = [], pageErrors = []
await build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {useKnowledgeLibrary} from './src/client/workspace/knowledge/use-knowledge-library.ts';
import {useSqlKnowledge} from './src/client/sql/use-sql-knowledge.tsx';
import {KnowledgeLibrary} from './src/client/workspace/knowledge/knowledge-library.tsx';
const params=new URLSearchParams(location.search), sourceId=params.get('source');
const bridge={templates:async(action,body)=>{
 if(action.endsWith('-get')&&!action.includes('tidy')&&window.failGet){window.failGet=false;throw Error('Controlled read failure');}
 const response=await fetch('/api',{method:'POST',body:JSON.stringify({sourceId,action,...body})});
 const data=await response.json();if(!response.ok){if(window.delayFailure){window.delayFailure=false;window.failurePending=true;await new Promise(resolve=>window.releaseFailure=resolve);window.failurePending=false;}throw Error(data.error);}
 if(action.endsWith('-get')&&!action.includes('tidy')&&window.delayGet){window.delayGet=false;window.loadPending=true;await new Promise(resolve=>window.releaseLoad=resolve);window.loadPending=false;}
 if(action.endsWith('-publish')&&window.delaySave){window.delaySave=false;window.savePending=true;await new Promise(resolve=>window.releaseSave=resolve);window.savePending=false;}
 if(action.endsWith('-archive')&&window.delayArchive){window.delayArchive=false;window.archivePending=true;await new Promise(resolve=>window.releaseArchive=resolve);window.archivePending=false;}
 return data;
}};
function Controls({view}){window.current=view;return <>
 <KnowledgeLibrary sourceName={sourceId} items={view.items.map(item=>({...item,subtitle:item.subtitle||''}))} selectedId={view.selectedId} onSelect={view.select}
 search={view.search||''} onSearch={view.onSearch||view.setSearch} title={view.title} onTitle={view.setTitle} summary={view.summary} onSummary={view.setSummary}
 tags={view.tags} onTags={view.setTags} busy={view.busy} editorDisabled={view.editorDisabled} error={view.error} analysis={view.analysis} draftLabel="新建草稿"
 onSave={view.save} onRun={view.onRun||view.tryRun} onUse={view.onUse||view.useForQuery} onArchive={view.onArchive||view.archive}/>
 <span id="error">{view.error}</span>
 </>}
function Command({connection}){const [context,setContext]=useState('0');window.changeExecutionContext=setContext;const view=useKnowledgeLibrary(bridge,connection,true,async()=>({}),()=>{},context);return <><select aria-label="执行 DB" value={context} onChange={e=>setContext(e.target.value)}><option>0</option><option>1</option></select><textarea aria-label="text" disabled={view.editorDisabled} value={view.text} onChange={e=>view.setText(e.target.value)}/><Controls view={view}/></>}
function Sql({connection}){const props=useSqlKnowledge({bridge,connection,initialSql:'SELECT id, price FROM orders WHERE status = :status',onClose:()=>{},onSaved:id=>(window.savedIds??=[]).push(id)});return <Controls view={{...props,select:props.onSelect,save:props.onSave,setTitle:props.onTitle,setSummary:props.onSummary,setTags:props.onTags}}/>}
function App(){const [id,setId]=useState(params.get('connection'));window.changeConnection=setId;const connection={id,generation:'g1',dialect:sourceId,live:false,environment:'sit'};return ['mysql','oracle'].includes(sourceId)?<Sql connection={connection}/>:<Command connection={connection}/>}
createRoot(document.getElementById('app')).render(<App/>);
` }, bundle: true, format: 'esm', outfile: resolve(out, 'fixture.js') })
const server = createServer(async (request, response) => {
  try {
    if (request.method === 'POST') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(structuredClone(body))
      const result = await service.dispatch(body.sourceId, body.connectionId, body)
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result)); return
    }
    response.setHeader('Content-Type', request.url.startsWith('/fixture.js') ? 'application/javascript' : 'text/html')
    response.end(request.url.startsWith('/fixture.js') ? await readFile(resolve(out, 'fixture.js')) : '<div id="app"></div><script type="module" src="/fixture.js"></script>')
  } catch (error) { response.writeHead(409, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message })) }
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const browser = await chromium.launch({ channel: 'msedge', headless: true })
let serial = 0
const rows = (sourceId, connectionId) => sqlSources.has(sourceId) ? store.search('', sourceId, connectionId) : store.searchKnowledge(sourceId, connectionId)
async function setup(sourceId) {
  const connectionId = `async-${sourceId}-${++serial}`, items = []
  for (const title of ['Original', 'Other']) items.push(sqlSources.has(sourceId)
    ? await store.publish({ dialect: sourceId, connectionId, action: 'create', title, sql: title === 'Original' ? 'SELECT id FROM orders' : 'SELECT amount FROM payments' })
    : store.publishKnowledge({ sourceId, connectionId, title, text: sourceId === 'redis' ? `GET ${title}` : title === 'Original' ? 'TOPICS' : 'GROUPS' }))
  await store.whenIdle()
  const page = await browser.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => pageErrors.push(error.message))
  console.log(`START ${connectionId}`)
  await page.goto(`http://127.0.0.1:${server.address().port}/?source=${sourceId}&connection=${connectionId}`)
  await page.waitForFunction(() => window.current?.items.length === 2)
  return { page, connectionId, items }
}
async function select(page, id, expectedTitle) {
  if (id) await (await entry(page, id)).locator('.db-template-list-main').click()
  else await page.getByRole('button', { name: '新建草稿', exact: true }).click()
  if (expectedTitle !== undefined) await page.waitForFunction(title => window.current.title === title && !window.current.editorDisabled, expectedTitle)
}
async function entry(page, id) {
  const index = await page.evaluate(id => window.current.items.findIndex(item => item.id === id), id)
  assert.ok(index >= 0, 'entry remains in the visible list: ' + id)
  return page.locator('.db-template-list-row').nth(index)
}
const title = page => page.getByLabel('标题', { exact: true })
async function save(page) {
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForFunction(() => !window.current.busy)
}
async function holdSave(page) {
  await page.evaluate(() => { window.delaySave = true })
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForFunction(() => window.savePending === true)
}
async function releaseSave(page) { await page.evaluate(() => window.releaseSave()); await page.waitForFunction(() => !window.current.busy) }
try {
  for (const sourceId of sources) {
    {
      const { page, items } = await setup(sourceId)
      await title(page).fill('Earlier unsaved draft')
      await select(page, items[0].id, 'Original'); await title(page).fill('Existing item edits')
      await select(page, '', '')
      assert.equal(await page.evaluate(() => window.current.selectedId || ''), '')
      await page.getByLabel('保留的草稿').locator('p').filter({ hasText: 'Earlier unsaved draft' }).getByRole('button').click()
      assert.equal(await title(page).inputValue(), 'Earlier unsaved draft')
      await select(page, items[0].id, 'Existing item edits')
      evidence.push({ sourceId, scenario: 'new draft from an existing entry never reuses the earlier unsaved draft', status: 'PASS' }); await page.close()
    }
    {
      const { page, connectionId, items } = await setup(sourceId)
      await select(page, items[0].id, 'Original')
      await title(page).fill('First save'); await page.getByLabel('标签', { exact: true }).fill('orders, orders')
      await holdSave(page)
      assert.ok(await title(page).isEnabled())
      await title(page).fill('Second edit while saving'); await releaseSave(page)
      assert.equal(await title(page).inputValue(), 'Second edit while saving')
      assert.equal(await page.getByLabel('标签', { exact: true }).inputValue(), 'orders')
      await save(page)
      assert.equal(await page.locator('#error').innerText(), '')
      assert.equal(rows(sourceId, connectionId).find(x => x.title === 'Second edit while saving').version, 3)
      const publications = calls.filter(x => x.connectionId === connectionId && x.action.endsWith('-publish'))
      assert.deepEqual(publications.map(x => x.expectedVersion), [1, 2])
      if (sqlSources.has(sourceId)) assert.equal(publications[1].targetId, await page.evaluate(() => window.savedIds[0]))
      evidence.push({ sourceId, scenario: 'edit during save; normalized untouched field; subsequent save', status: 'PASS' })
      await page.close()
    }
    {
      const { page, connectionId } = await setup(sourceId)
      if (!sqlSources.has(sourceId)) await page.getByLabel('text', { exact: true }).fill(sourceId === 'redis' ? 'GET new-key' : 'TOPICS SEARCH "new-prefix"')
      await title(page).fill('New draft'); await holdSave(page)
      await title(page).fill('New draft continued'); await releaseSave(page); await save(page)
      const publications = calls.filter(x => x.connectionId === connectionId && x.action.endsWith('-publish'))
      assert.equal(publications[0].expectedVersion, undefined)
      assert.equal(publications[1].expectedVersion, 1)
      assert.equal(rows(sourceId, connectionId).find(x => x.title === 'New draft continued').version, 2)
      evidence.push({ sourceId, scenario: 'first create receipt owns continued draft', status: 'PASS' })
      await page.close()
    }
    {
      const { page, items } = await setup(sourceId)
      await select(page, items[0].id, 'Original'); await title(page).fill('Saved in background'); await holdSave(page)
      await select(page, items[1].id, 'Other'); await title(page).fill('Other unsaved'); await releaseSave(page)
      assert.equal(await title(page).inputValue(), 'Other unsaved')
      assert.equal(await page.evaluate(() => window.current.selectedId), items[1].id)
      const returnedId = await page.evaluate(() => window.current.items.find(x => x.title === 'Saved in background').id)
      await select(page, returnedId, 'Saved in background'); await title(page).fill('Returned edit'); await save(page)
      assert.equal(await page.locator('#error').innerText(), '')
      if (sqlSources.has(sourceId)) {
        const savedId = await page.evaluate(() => window.current.selectedId)
        await holdSave(page); await select(page, items[1].id, 'Other unsaved')
        await select(page, savedId, 'Returned edit'); await title(page).fill('Returned during pending save')
        await releaseSave(page); await save(page)
        assert.equal(await page.locator('#error').innerText(), '')
        assert.equal(await title(page).inputValue(), 'Returned during pending save')
      }
      evidence.push({ sourceId, scenario: 'background save does not steal selection; return and save', status: 'PASS' })
      await page.close()
    }
    {
      const { page, connectionId, items } = await setup(sourceId)
      await select(page, items[0].id, 'Original'); await title(page).fill('Old connection save'); await holdSave(page)
      await page.evaluate(id => window.changeConnection(id), `${connectionId}-other`)
      await page.waitForFunction(() => window.current.title === '' && window.current.items.length === 0)
      await title(page).fill('New connection draft'); await page.evaluate(() => window.releaseSave())
      await page.waitForFunction(() => !window.savePending)
      assert.equal(await title(page).inputValue(), 'New connection draft')
      assert.equal(await page.evaluate(() => window.current.items.length), 0)
      evidence.push({ sourceId, scenario: 'late receipt cannot adopt another connection draft', status: 'PASS' })
      await page.close()
    }
    {
      const { page, connectionId, items } = await setup(sourceId)
      await select(page, items[0].id, 'Original'); await title(page).fill('Unsaved after external approval')
      const batch = store.proposeTidy({ sourceId, connectionId, changes: [{ id: items[0].id, kind: 'update', title: 'Externally approved', sql: sqlSources.has(sourceId) ? 'SELECT id, name FROM orders' : sourceId === 'redis' ? 'GET approved' : 'TOPICS SEARCH "approved-prefix"' }] })
      await store.applyTidy(connectionId, batch.id)
      await page.evaluate(() => { window.delayFailure = true })
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await page.waitForFunction(() => window.failurePending === true)
      await title(page).fill('Edited while save failure pending')
      await page.evaluate(() => window.releaseFailure()); await page.waitForFunction(() => !window.current.busy)
      assert.match(await page.locator('#error').innerText(), /已被其他人更新|知识条目已更新/)
      assert.equal(await title(page).inputValue(), 'Edited while save failure pending')
      evidence.push({ sourceId, scenario: 'external update still conflicts and retains edited draft', status: 'PASS' })
      await page.close()
    }
    {
      const { page, connectionId, items } = await setup(sourceId)
      await select(page, items[0].id, 'Original'); await title(page).fill('Our pending save'); await holdSave(page)
      const subject = rows(sourceId, connectionId).find(x => x.title === 'Our pending save')
      const batch = store.proposeTidy({ sourceId, connectionId, changes: [{ id: subject.id, kind: 'update', title: 'Approved during pending response' }] })
      assert.equal((await store.applyTidy(connectionId, batch.id)).applied.length, 1)
      await title(page).fill('Continued local edit'); await releaseSave(page); await save(page)
      assert.match(await page.locator('#error').innerText(), /已被其他人更新|知识条目已更新/)
      assert.equal(await title(page).inputValue(), 'Continued local edit')
      const last = calls.filter(x => x.connectionId === connectionId && x.action.endsWith('-publish')).at(-1)
      assert.equal(last.expectedVersion, 2)
      if (sqlSources.has(sourceId)) assert.equal(last.expectedSnapshot.title, 'Our pending save')
      evidence.push({ sourceId, scenario: 'own acknowledgement does not absorb an external approval during pending response', status: 'PASS' })
      await page.close()
    }
    {
      const { page, items } = await setup(sourceId)
      await select(page, items[0].id, 'Original'); await title(page).fill('Previous draft save'); await holdSave(page)
      await select(page, '', ''); await title(page).fill('Independent new draft'); await releaseSave(page)
      assert.equal(await title(page).inputValue(), 'Independent new draft')
      assert.ok(!(await page.evaluate(() => window.current.selectedId)))
      evidence.push({ sourceId, scenario: 'new draft never adopts previous draft receipt', status: 'PASS' })
      await page.close()
    }
  }
  for (const sourceId of sources) {
    {
      const { page, items } = await setup(sourceId)
      await select(page, items[0].id, 'Original'); const tags = page.getByLabel('标签', { exact: true })
      await tags.fill('orders, orders'); await holdSave(page)
      await tags.fill('temporary'); await tags.fill('orders, orders'); await releaseSave(page)
      assert.equal(await tags.inputValue(), 'orders, orders')
      await save(page); assert.equal(await tags.inputValue(), 'orders')
      assert.equal(await page.locator('#error').innerText(), '')
      evidence.push({ sourceId, scenario: 'edit then revert a field during save preserves the explicit edit revision', status: 'PASS' }); await page.close()
    }
    {
      const { page, connectionId, items } = await setup(sourceId)
      await select(page, items[0].id, 'Original'); await title(page).fill('Earlier connection generation'); await holdSave(page)
      await page.evaluate(id => window.changeConnection(id), connectionId + '-other')
      await page.waitForFunction(() => window.current.items.length === 0)
      await page.evaluate(id => window.changeConnection(id), connectionId)
      await page.waitForFunction(() => window.current.items.length === 2)
      await select(page, items[1].id, 'Other'); await title(page).fill('Returned connection draft'); await page.evaluate(() => window.releaseSave())
      await page.waitForFunction(() => !window.savePending)
      assert.equal(await title(page).inputValue(), 'Returned connection draft')
      await save(page); assert.equal(await page.locator('#error').innerText(), '')
      evidence.push({ sourceId, scenario: 'connection A to B to A cannot accept the earlier generation receipt', status: 'PASS' }); await page.close()
    }
    {
      const { page } = await setup(sourceId)
      if (!sqlSources.has(sourceId)) await page.getByLabel('text', { exact: true }).fill(sourceId === 'redis' ? 'GET multi-draft' : 'TOPICS SEARCH "multi-draft"')
      await title(page).fill('First pending draft'); await holdSave(page)
      await select(page, '', ''); await title(page).fill('Second retained draft')
      await select(page, '', ''); await title(page).fill('Third active draft'); await releaseSave(page)
      assert.equal(await title(page).inputValue(), 'Third active draft')
      await page.getByLabel('保留的草稿').locator('p').filter({ hasText: 'First pending draft' }).getByRole('button').click()
      assert.equal(await title(page).inputValue(), 'First pending draft')
      await title(page).fill('First recovered and saved'); await save(page); assert.equal(await page.locator('#error').innerText(), '')
      await page.getByLabel('保留的草稿').locator('p').filter({ hasText: 'Second retained draft' }).getByRole('button').click()
      assert.equal(await title(page).inputValue(), 'Second retained draft')
      evidence.push({ sourceId, scenario: 'multiple new drafts preserve every dirty and pending owner', status: 'PASS' }); await page.close()
    }
  }
  for (const sourceId of ['redis', 'kafka']) {
    const { page, connectionId, items } = await setup(sourceId)
    await select(page, items[0].id, 'Original'); await title(page).fill('Own pending save'); await holdSave(page)
    await select(page, items[1].id, 'Other'); await select(page, items[0].id, 'Own pending save')
    await title(page).fill('Returned before receipt'); await releaseSave(page); await save(page)
    assert.equal(await page.locator('#error').innerText(), '')
    assert.deepEqual(calls.filter(x => x.connectionId === connectionId && x.action.endsWith('-publish')).map(x => x.expectedVersion), [1, 2])
    evidence.push({ sourceId, scenario: 'return before own save receipt preserves owner and next-save base', status: 'PASS' }); await page.close()
    {
      const { page, items } = await setup(sourceId)
      await select(page, items[0].id, 'Original'); await title(page).fill('Reload preserved draft')
      await page.evaluate(() => { window.delayGet = true })
      await page.getByRole('button', { name: '重新加载（保留草稿）' }).click(); await page.waitForFunction(() => window.loadPending)
      assert.ok(await title(page).isDisabled())
      await select(page, items[1].id, 'Other'); await page.evaluate(() => window.releaseLoad())
      await select(page, items[0].id, 'Original')
      await page.getByLabel('保留的草稿').locator('p').filter({ hasText: 'Reload preserved draft' }).getByRole('button').click()
      assert.equal(await title(page).inputValue(), 'Reload preserved draft')
      await page.evaluate(() => { window.failGet = true })
      await page.getByRole('button', { name: '重新加载（保留草稿）' }).click()
      await page.waitForFunction(() => /Controlled read failure/.test(window.current.error))
      await page.getByRole('button', { name: '重新读取' }).click(); await page.waitForFunction(() => window.current.title === 'Original')
      evidence.push({ sourceId, scenario: 'reload follows its owner when selection changes; failure retry remains usable', status: 'PASS' }); await page.close()
    }
  }
  {
    const { page, connectionId, items } = await setup('redis')
    await select(page, items[0].id, 'Original'); await title(page).fill('Pending DB0 save'); await holdSave(page)
    await page.getByLabel('执行 DB').selectOption('1')
    assert.equal(await page.evaluate(() => window.current.busy), true)
    await title(page).fill('DB1 retained draft'); await page.getByLabel('执行 DB').selectOption('0')
    await releaseSave(page); await save(page)
    assert.equal(await page.locator('#error').innerText(), '')
    assert.deepEqual(calls.filter(x => x.connectionId === connectionId && x.action.endsWith('-publish')).map(x => x.expectedVersion), [1, 2])
    evidence.push({ sourceId: 'redis', scenario: 'DB0 to DB1 to DB0 keeps save lock and acknowledgement', status: 'PASS' }); await page.close()
  }
  for (const sourceId of sqlSources) {
    {
      const { page, connectionId, items } = await setup(sourceId)
      await select(page, items[0].id, 'Original'); await title(page).fill('Latest to archive'); await save(page)
      const head = rows(sourceId, connectionId).find(x => x.title === 'Latest to archive')
      await page.evaluate(() => { window.delayArchive = true })
      await (await entry(page, head.id)).locator('.db-template-list-delete').click()
      await page.waitForFunction(() => window.archivePending)
      await title(page).fill('Edited during archive'); await page.evaluate(() => window.releaseArchive()); await page.waitForFunction(() => !window.current.busy)
      assert.equal(await title(page).inputValue(), 'Edited during archive')
      assert.ok(store.ensure().templates.filter(x => x.lineageId === head.lineageId).every(x => x.archived))
      await page.getByRole('button', { name: '另存为新模板' }).click(); await page.waitForFunction(() => !window.current.busy)
      assert.equal(await page.locator('#error').innerText(), '')
      const copy = rows(sourceId, connectionId).find(x => x.title === 'Edited during archive')
      assert.ok(copy); assert.notEqual(copy.lineageId, head.lineageId); assert.equal(copy.version, 1)
      evidence.push({ sourceId, scenario: 'archive hides complete chain, keeps edits during receipt, and copies to new lineage', status: 'PASS' }); await page.close()
    }
    {
      const { page, connectionId, items } = await setup(sourceId)
      await select(page, items[0].id, 'Original'); await page.evaluate(() => { window.delayArchive = true })
      await (await entry(page, items[0].id)).locator('.db-template-list-delete').click(); await page.waitForFunction(() => window.archivePending)
      await page.evaluate(id => window.changeConnection(id), connectionId + '-other'); await page.waitForFunction(() => window.current.items.length === 0)
      await page.evaluate(id => window.changeConnection(id), connectionId); await page.waitForFunction(() => window.current.items.length === 1)
      await select(page, items[1].id, 'Other'); await title(page).fill('New generation pending'); await holdSave(page)
      await page.evaluate(() => window.releaseArchive()); await page.waitForFunction(() => !window.archivePending)
      assert.equal(await page.evaluate(() => window.current.busy), true)
      assert.equal(await title(page).inputValue(), 'New generation pending')
      await releaseSave(page); assert.equal(await page.locator('#error').innerText(), '')
      evidence.push({ sourceId, scenario: 'old archive receipt cannot unlock or change a new generation save', status: 'PASS' }); await page.close()
    }
    {
      const { page, connectionId } = await setup(sourceId)
      await page.getByRole('button', { name: '合并元数据', exact: true }).first().waitFor()
      await title(page).fill('Merge publisher'); await page.evaluate(() => { window.delaySave = true })
      await page.getByRole('button', { name: '合并元数据', exact: true }).first().click(); await page.waitForFunction(() => window.savePending === true)
      const publication = calls.filter(x => x.connectionId === connectionId && x.action.endsWith('-publish')).at(-1)
      await select(page, publication.targetId, 'Merge publisher'); await title(page).fill('Target unsaved title')
      await releaseSave(page); await page.getByLabel('简介', { exact: true }).fill('Target continued summary')
      assert.equal(await title(page).inputValue(), 'Target unsaved title')
      await save(page); assert.equal(await page.locator('#error').innerText(), '')
      const recovered = page.getByLabel('保留的草稿').locator('p').filter({ hasText: 'Merge publisher' })
      await recovered.getByRole('button', { name: '恢复未保存草稿' }).click()
      assert.equal(await title(page).inputValue(), 'Merge publisher')
      await save(page); assert.match(await page.locator('#error').innerText(), /已被其他人更新/)
      evidence.push({ sourceId, scenario: 'background merge keeps distinct target and publisher drafts; restored stale owner conflicts', status: 'PASS' }); await page.close()
    }
    {
      const { page, connectionId, items } = await setup(sourceId)
      await select(page, items[1].id, 'Other'); await page.evaluate(() => { window.delayGet = true }); await select(page, items[0].id)
      await page.waitForFunction(() => window.loadPending === true)
      assert.ok(await title(page).isDisabled()); assert.equal(await title(page).inputValue(), '')
      assert.ok(await page.getByRole('button', { name: '保存', exact: true }).isDisabled())
      const before = calls.filter(x => x.connectionId === connectionId && x.action.endsWith('-publish')).length
      await page.evaluate(() => { window.current.setTitle('Blocked input'); window.current.save(); window.current.onRun(); window.current.onUse() })
      await select(page, items[1].id, 'Other')
      await page.evaluate(() => window.releaseLoad()); await page.waitForFunction(() => !window.loadPending)
      assert.equal(await title(page).inputValue(), 'Other')
      assert.equal(calls.filter(x => x.connectionId === connectionId && x.action.endsWith('-publish')).length, before)
      await select(page, items[0].id, 'Original')
      evidence.push({ sourceId, scenario: 'load locks editor and actions; stale read cannot overwrite another item', status: 'PASS' })
      await page.close()
    }
    {
      const { page, connectionId } = await setup(sourceId)
      await title(page).fill('Initial pending draft'); await holdSave(page)
      await select(page, '', ''); await title(page).fill('New independent draft'); await releaseSave(page)
      assert.equal(await title(page).inputValue(), 'New independent draft')
      assert.ok(!(await page.evaluate(() => window.current.selectedId)))
      await page.getByRole('button', { name: '恢复未保存草稿', exact: true }).click()
      await page.waitForFunction(() => window.current.title === 'Initial pending draft')
      await title(page).fill('Recovered acknowledged draft'); await save(page)
      assert.equal(await page.locator('#error').innerText(), '')
      const last = calls.filter(x => x.connectionId === connectionId && x.action.endsWith('-publish')).at(-1)
      assert.equal(last.expectedVersion, 1); assert.equal(last.publishAction, 'newVersion')
      evidence.push({ sourceId, scenario: 'new draft during first create preserves the old draft with its own acknowledged baseline', status: 'PASS' })
      await page.close()
    }
    {
      const { page, items } = await setup(sourceId)
      await page.evaluate(() => { window.failGet = true }); await select(page, items[0].id)
      await page.waitForFunction(() => /Controlled read failure/.test(window.current.error))
      assert.ok(await title(page).isDisabled())
      await page.getByRole('button', { name: '重新读取', exact: true }).click()
      await page.waitForFunction(() => window.current.title === 'Original' && !window.current.editorDisabled)
      await title(page).fill('Preserved input')
      await page.getByRole('button', { name: '重新加载（保留草稿）', exact: true }).click()
      await page.waitForFunction(() => window.current.title === 'Original' && !window.current.editorDisabled)
      await page.getByRole('button', { name: '恢复未保存草稿', exact: true }).click()
      await page.waitForFunction(() => window.current.title === 'Preserved input')
      await save(page); assert.equal(await page.locator('#error').innerText(), '')
      evidence.push({ sourceId, scenario: 'read failure retry; same-ID reload preserves recoverable draft', status: 'PASS' })
      await page.close()
    }
    {
      const { page, connectionId, items } = await setup(sourceId)
      await page.getByRole('button', { name: '变体', exact: true }).first().waitFor()
      await title(page).fill('Variant publication')
      await page.evaluate(() => { window.delaySave = true })
      await page.getByRole('button', { name: '变体', exact: true }).first().click()
      await page.waitForFunction(() => window.savePending === true)
      await title(page).fill('Variant continued edit'); await releaseSave(page)
      const selected = await page.evaluate(() => window.current.selectedId)
      assert.notEqual(selected, items[0].id)
      assert.equal(await title(page).inputValue(), 'Variant continued edit')
      await save(page)
      assert.equal(await page.locator('#error').innerText(), '')
      const branch = rows(sourceId, connectionId).find(x => x.title === 'Variant continued edit')
      assert.equal(branch.version, 2); assert.equal(branch.familyId, items[0].familyId)
      assert.notEqual(branch.lineageId, items[0].lineageId)
      assert.equal(calls.find(x => x.connectionId === connectionId && x.publishAction === 'variant').expectedSnapshot.title, 'Original')
      evidence.push({ sourceId, scenario: 'similar variant publishes actual new ID and retains continued edits with next-save base', status: 'PASS' })
      await page.close()
    }
  }
  assert.deepEqual(pageErrors, [])
  const report = { status: 'PASS', scope: 'production Hooks and KnowledgeLibrary with actual Host store over local HTTP; controlled connection and execution DB; fixture command editor; external services NOT_RUN', checks: evidence.length, evidence, pageErrors }
  await writeFile(resolve(out, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
} catch (error) {
  const report = { status: 'FAIL', evidence, calls: calls.slice(-30), pageErrors, pages: await Promise.all(browser.contexts().flatMap(context => context.pages()).map(async page => ({
    url: page.url(), state: await page.evaluate(() => ({ title: window.current?.title, error: window.current?.error, selectedId: window.current?.selectedId, busy: window.current?.busy, savedIds: window.savedIds }))
  }))), error: error.stack }
  await writeFile(resolve(out, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); throw error
} finally { await browser.close(); await new Promise(done => server.close(done)) }

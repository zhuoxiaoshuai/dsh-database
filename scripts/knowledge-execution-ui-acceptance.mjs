import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { SqlTemplateStore } from '../src/host/sql-template-store.ts'
import { KnowledgeService } from '../src/host/knowledge-service.ts'

// Actual Hooks, production metadata fields and durable Host stores; only timing/failures are controlled.
const out = resolve('artifacts/ui/knowledge-execution')
await mkdir(out, { recursive: true })
const store = new SqlTemplateStore(await mkdtemp(resolve(out, 'store-'))), service = new KnowledgeService(store)
const sqlSources = new Set(['mysql', 'oracle']), sources = ['mysql', 'oracle', 'redis', 'kafka']
const calls = [], evidence = [], pageErrors = []
await build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {useKnowledgeLibrary} from './src/client/workspace/knowledge/use-knowledge-library.ts';
import {useSqlKnowledge} from './src/client/sql/use-sql-knowledge.tsx';
import {SchemaCache} from './src/client/schema/schema-cache.ts';
import './src/client/style.css';
import {KnowledgeLibrary} from './src/client/workspace/knowledge/knowledge-library.tsx';
const params=new URLSearchParams(location.search), sourceId=params.get('source');
const bridge={catalog:async()=>({items:[]}), execute:async(connection,sql,signal)=>{
 const mode=window.nextRun||'success';window.nextRun='success';
 const index=window.executions=(window.executions||0)+1;
 const result={columns:['proof'],rows:[['RECEIPT_MARKER_'+index]],elapsedMs:1,truncated:false};
 const partial=()=>Object.assign(Error('Controlled partial unknown'),{effect:'unknown',steps:[{index:0,sql:'INSERT INTO a VALUES (1)',status:'succeeded',affectedRows:1},{index:1,sql:'INSERT INTO b VALUES (2)',status:'unknown'},{index:2,sql:'INSERT INTO c VALUES (3)',status:'not-run'}],batch:[{columns:[],rows:[],elapsedMs:1,truncated:false,affectedRows:1}]});
 if(mode==='failure')throw Object.assign(Error('Controlled execution failure'),{effect:'none',phase:'check'});
 if(mode==='partial')throw partial();
 if(mode==='defer'||mode==='stop-partial')return new Promise((resolve,reject)=>{
   (window.runs||=[]).push({resolve:()=>resolve(result),reject:()=>reject(partial()),index,sql});
   if(mode==='stop-partial')signal.addEventListener('abort',()=>reject(partial()),{once:true});
 });
 return result;
},templates:async(action,body)=>{
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
 execution={params.get('run')==='1'?view.execution:undefined} onSave={view.save} onRun={view.onRun||view.tryRun} onUse={view.onUse||view.useForQuery} onArchive={view.onArchive||view.archive}/>
 <span id="error">{view.error}</span>
 </>}
function Command({connection}){const [context,setContext]=useState('0');window.changeExecutionContext=setContext;const view=useKnowledgeLibrary(bridge,connection,true,async()=>({}),()=>{},context);return <><select aria-label="执行 DB" value={context} onChange={e=>setContext(e.target.value)}><option>0</option><option>1</option></select><textarea aria-label="text" disabled={view.editorDisabled} value={view.text} onChange={e=>view.setText(e.target.value)}/><Controls view={view}/></>}
function Sql({connection}){const [cache]=useState(()=>new SchemaCache(bridge.catalog));const [schema,setSchema]=useState('app');window.changeSchema=setSchema;const props=useSqlKnowledge({bridge,connection,cache,schema,initialSql:params.get('run')==='1'?(params.get('initial')||''):'SELECT id, price FROM orders WHERE status = :status',onClose:()=>{},onSaved:id=>(window.savedIds??=[]).push(id)});return <Controls view={{...props,select:props.onSelect,save:props.onSave,setTitle:props.onTitle,setSummary:props.onSummary,setTags:props.onTags}}/>}
function App(){const [id,setId]=useState(params.get('connection'));const [generation,setGeneration]=useState('g1');window.changeGeneration=setGeneration;window.changeConnection=setId;const connection={id,generation,dialect:sourceId,live:params.get('run')==='1',environment:'sit'};return ['mysql','oracle'].includes(sourceId)?<Sql connection={connection}/>:<Command connection={connection}/>}
createRoot(document.getElementById('app')).render(params.get('strict')==='1'?<React.StrictMode><App/></React.StrictMode>:<App/>);
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
async function setup(sourceId, strict = false, initial = '') {
  const connectionId = `async-${sourceId}-${++serial}`, items = []
  for (const title of ['Original', 'Other']) items.push(sqlSources.has(sourceId)
    ? await store.publish({ dialect: sourceId, connectionId, action: 'create', title, sql: title === 'Original' ? 'SELECT id FROM orders' : 'SELECT amount FROM payments' })
    : store.publishKnowledge({ sourceId, connectionId, title, text: sourceId === 'redis' ? `GET ${title}` : title === 'Original' ? 'TOPICS' : 'GROUPS' }))
  await store.whenIdle()
  const page = await browser.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => pageErrors.push(error.message))
  console.log(`START ${connectionId}`)
  await page.goto(`http://127.0.0.1:${server.address().port}/?source=${sourceId}&connection=${connectionId}&run=1&strict=${strict ? '1' : '0'}&initial=${encodeURIComponent(initial)}`)
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
const editor=page=>page.getByLabel('SQL 编辑器',{exact:true});
const runButton=page=>page.locator('.db-sql-toolbar-btn').filter({hasText:'运行'});
const steps=page=>page.evaluate(()=>window.current.execution.props.resultFrame.props.message.props.localSteps?.map(step=>({status:step.status,writeReceipt:step.writeReceipt,affectedRows:step.result?.affectedRows})));
async function run(page,sql='SELECT 1',mode='success'){
 await editor(page).fill(sql);await page.evaluate(mode=>window.nextRun=mode,mode);
 await runButton(page).click();
 if(mode!=='defer'&&mode!=='stop-partial')await page.waitForFunction(()=>!window.current.busy);
}
async function expectReceipt(page,index){await page.getByText('RECEIPT_MARKER_'+index,{exact:true}).waitFor();assert.deepEqual((await steps(page)).map(x=>x.status),['ok']);}
const batch='INSERT INTO a VALUES (1); INSERT INTO b VALUES (2); INSERT INTO c VALUES (3)';
try{
 for(const sourceId of ['mysql','oracle']){
  {
   const {page}=await setup(sourceId,true,'SELECT 7');
   await runButton(page).click();await page.waitForFunction(()=>!window.current.busy);await expectReceipt(page,1);
   await page.locator('.db-sql-toolbar-btn').filter({hasText:'解释'}).click();await page.waitForFunction(()=>!window.current.busy);await expectReceipt(page,2);
   await page.evaluate(()=>window.changeGeneration('g2'));await run(page);await expectReceipt(page,3);
   await run(page,'SELECT 4','defer');await page.waitForFunction(()=>window.runs?.length===1);
   await select(page,'','');await page.evaluate(()=>window.runs[0].resolve());await page.waitForFunction(()=>!window.current.busy);
   assert.equal(await page.getByText('RECEIPT_MARKER_4',{exact:true}).count(),0);
   await run(page);await expectReceipt(page,5);
   evidence.push({sourceId,scenario:'StrictMode initial SQL, explain, reconnect and new draft reject the prior draft result',status:'PASS'});await page.close();
  }
  {
   const {page,connectionId}=await setup(sourceId);
   await run(page);await expectReceipt(page,1);
   await select(page,'','');await run(page);await expectReceipt(page,2);
   await page.evaluate(()=>window.changeGeneration('g2'));await run(page);await expectReceipt(page,3);
   await page.evaluate(id=>window.changeConnection(id),connectionId+'-other');await run(page);await expectReceipt(page,4);
   await page.evaluate(()=>window.changeSchema('OTHER'));await run(page);await expectReceipt(page,5);
   evidence.push({sourceId,scenario:'initial, explicit new, generation, connection and schema drafts accept their own execution receipt',status:'PASS'});await page.close();
  }
  {
   const {page}=await setup(sourceId);
   await run(page,'SELECT 1','failure');assert.deepEqual((await steps(page)).map(x=>x.status),['failed']);
   assert.ok((await page.locator('body').innerText()).includes('Controlled execution failure'));
   await run(page,batch,'partial');assert.deepEqual((await steps(page)).map(x=>x.status),['ok','unknown','skipped']);
   assert.equal((await steps(page))[0].affectedRows,1);assert.equal((await steps(page))[1].writeReceipt,'unknown');
   evidence.push({sourceId,scenario:'initial failure and partial unknown preserve terminal facts',status:'PASS'});await page.close();
  }
  {
   const {page}=await setup(sourceId);
   await run(page,batch,'stop-partial');await page.waitForFunction(()=>window.runs?.length===1);
   await page.locator('.db-sql-toolbar-btn').filter({hasText:'停止'}).click();await page.waitForFunction(()=>!window.current.busy);
   assert.deepEqual((await steps(page)).map(x=>x.status),['ok','unknown','skipped']);
   evidence.push({sourceId,scenario:'stop retains confirmed prefix and unknown terminal receipt',status:'PASS'});await page.close();
  }
  {
   const {page}=await setup(sourceId);
   await run(page,'SELECT 1','defer');await page.waitForFunction(()=>window.runs?.length===1);
   await page.locator('.db-sql-toolbar-btn').filter({hasText:'停止'}).click();
   await page.evaluate(()=>window.runs[0].resolve());await page.waitForFunction(()=>!window.current.busy);
   assert.ok((await steps(page)).every(x=>!['ok','pending','running'].includes(x.status)));
   assert.equal(await page.getByText('RECEIPT_MARKER_1',{exact:true}).count(),0);
   await run(page);await expectReceipt(page,2);
   evidence.push({sourceId,scenario:'late success after stop cannot revive success; next run works',status:'PASS'});await page.close();
  }
  {
   const {page}=await setup(sourceId);
   await run(page,'SELECT 1','defer');await page.waitForFunction(()=>window.runs?.length===1);
   await page.evaluate(()=>window.changeSchema('OTHER'));await page.evaluate(()=>window.changeSchema('app'));
   await run(page,'SELECT 2','defer');await page.waitForFunction(()=>window.runs?.length===2);
   await page.evaluate(()=>window.runs[0].resolve());await page.waitForTimeout(100);
   assert.equal(await page.evaluate(()=>window.current.busy),true);
   assert.equal(await page.getByText('RECEIPT_MARKER_1',{exact:true}).count(),0);
   await page.evaluate(()=>window.runs[1].resolve());await page.waitForFunction(()=>!window.current.busy);await expectReceipt(page,2);
   evidence.push({sourceId,scenario:'schema A to B to A late result cannot overwrite or unlock current run',status:'PASS'});await page.close();
  }
  {
   const {page,items}=await setup(sourceId);
   await select(page,items[0].id,'Original');await run(page,'SELECT 1','defer');await page.waitForFunction(()=>window.runs?.length===1);
   await select(page,items[1].id,'Other');await page.evaluate(()=>window.runs[0].resolve());await page.waitForFunction(()=>!window.current.busy);
   assert.equal(await page.getByText('RECEIPT_MARKER_1',{exact:true}).count(),0);
   await select(page,items[0].id,'Original');await expectReceipt(page,1);
   evidence.push({sourceId,scenario:'background run updates only its owner and is restored when returning',status:'PASS'});await page.close();
  }
 }
 assert.deepEqual(pageErrors,[]);const report={status:'PASS',checks:evidence.length,evidence,pageErrors,scope:'production SQL Hook, editor, controls and result frame; actual knowledge Host store over HTTP; execution bridge controlled; real services NOT_RUN'};
 await writeFile(resolve(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await writeFile(resolve(out,'result.json'),JSON.stringify({status:'FAIL',evidence,pageErrors,error:error.stack},null,2));throw error}
finally{await browser.close();await new Promise(done=>server.close(done))}

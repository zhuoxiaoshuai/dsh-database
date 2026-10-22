import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { SqlTemplateStore } from '../src/host/sql-template-store.ts'
import { KnowledgeService } from '../src/host/knowledge-service.ts'

// Actual Hooks, production metadata fields and durable Host stores; only timing/failures are controlled.
const out = resolve('artifacts/ui/knowledge-execution-owner')
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
   (window.runs||=[]).push({resolve:()=>resolve(result),reject:()=>reject(partial()),fail:()=>reject(Object.assign(Error('Controlled execution failure'),{effect:'none',phase:'check'})),index,sql});
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
function App(){const [id,setId]=useState(params.get('connection'));const [generation,setGeneration]=useState('g1');window.changeGeneration=setGeneration;window.fixtureConnection=id;window.changeConnection=setId;const connection={id,generation,dialect:sourceId,live:params.get('run')==='1',environment:'sit'};return ['mysql','oracle'].includes(sourceId)?<Sql connection={connection}/>:<Command connection={connection}/>}
const appRoot=createRoot(document.getElementById('app'));window.unmountApp=()=>appRoot.unmount();appRoot.render(params.get('strict')==='1'?<React.StrictMode><App/></React.StrictMode>:<App/>);
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

try {
 for (const sourceId of ['mysql','oracle']) {
  {
   const {page}=await setup(sourceId);
   await title(page).fill('Retained run owner');
   await run(page,'SELECT 1','defer');await page.waitForFunction(()=>window.runs?.length===1);
   await select(page,'','');
   await page.evaluate(()=>window.runs[0].resolve());await page.waitForFunction(()=>!window.current.busy);
   assert.equal(await page.getByText('RECEIPT_MARKER_1',{exact:true}).count(),0);
   await page.getByLabel('保留的草稿',{exact:true}).getByRole('button',{name:'恢复未保存草稿',exact:true}).first().click();
   const actual=await steps(page);
   evidence.push({sourceId,scenario:'new draft then restore retained execution owner',expected:['ok'],actual,status:actual?.[0]?.status==='ok'?'PASS':'FAIL'});
   await page.close();
  }
  for (const field of ['title','sql','title-revert','summary','tags']) {
   const {page}=await setup(sourceId);
   await title(page).fill('before');
   await run(page,'SELECT 1','defer');await page.waitForFunction(()=>window.runs?.length===1);
   if(field==='sql')await editor(page).fill('SELECT 2');
   else if(field==='title-revert'){await title(page).fill('after');await title(page).fill('before');}
   else await page.getByLabel(field==='summary'?'简介':field==='tags'?'标签':'标题',{exact:true}).fill('after');
   await page.evaluate(()=>window.runs[0].resolve());await page.waitForFunction(()=>!window.current.busy);
   if(field==='sql')assert.equal(await editor(page).innerText(),'SELECT 2');
   else assert.equal(await page.getByLabel(field==='summary'?'简介':field==='tags'?'标签':'标题',{exact:true}).inputValue(),field==='title-revert'?'before':'after');
   const actual=await steps(page);const marker=await page.getByText('RECEIPT_MARKER_1',{exact:true}).count();
   evidence.push({sourceId,scenario:'edit '+field+' during successful run',expected:['ok'],actual,marker,status:actual?.[0]?.status==='ok'?'PASS':'FAIL',busy:await page.evaluate(()=>window.current.busy)});
   await page.close();
  }
  {
   const {page}=await setup(sourceId);
   await run(page,batch,'stop-partial');await page.waitForFunction(()=>window.runs?.length===1);
   await title(page).fill('metadata changed');
   await page.locator('.db-sql-toolbar-btn').filter({hasText:'停止'}).click();await page.waitForFunction(()=>!window.current.busy);
   const actual=await steps(page);
   evidence.push({sourceId,scenario:'edit title then stop partial write',expected:['ok','unknown','skipped'],actual,status:actual?.[1]?.status==='unknown'?'PASS':'FAIL'});
   await page.close();
  }
  {
   const {page,items}=await setup(sourceId);
   await select(page,items[0].id,'Original');await run(page,'SELECT 1','defer');await page.waitForFunction(()=>window.runs?.length===1);
   await select(page,items[1].id,'Other');await title(page).fill('other changed');
   await page.evaluate(()=>window.runs[0].resolve());await page.waitForFunction(()=>!window.current.busy);
   assert.equal(await page.getByText('RECEIPT_MARKER_1',{exact:true}).count(),0);
   await select(page,items[0].id,'Original');await expectReceipt(page,1);
   evidence.push({sourceId,scenario:'edit other draft during background run',status:'PASS'});await page.close();
  }
  {
   const {page,items}=await setup(sourceId);
   await run(page,'SELECT 1','defer');await page.waitForFunction(()=>window.runs?.length===1);
   await page.getByLabel('搜索经验库',{exact:true}).fill('Original');
   await page.evaluate(()=>window.runs[0].resolve());await page.waitForFunction(()=>!window.current.busy);await expectReceipt(page,1);
   evidence.push({sourceId,scenario:'filter list during run',status:'PASS'});await page.close();
  }
 }

 for(const sourceId of ['mysql','oracle']){
  const {page,items,connectionId}=await setup(sourceId,true);
  for(const field of ['sql','title','summary','tags','revert'])for(const outcome of ['failure','unknown']){
   await select(page,'','');await title(page).fill('before');await run(page,batch,'defer');
   if(field==='sql')await editor(page).fill('SELECT 2');
   else if(field==='revert'){await title(page).fill('temporary');await title(page).fill('before');}
   else await page.getByLabel(field==='summary'?'简介':field==='tags'?'标签':'标题',{exact:true}).fill('after');
   await page.evaluate(outcome=>outcome==='failure'?window.runs.at(-1).fail():window.runs.at(-1).reject(),outcome);
   await page.waitForFunction(()=>!window.current.busy);
   assert.deepEqual((await steps(page)).map(step=>step.status),outcome==='failure'?['failed','skipped','skipped']:['ok','unknown','skipped']);
   if(outcome==='unknown'){assert.equal((await steps(page))[0].affectedRows,1);assert.equal((await steps(page))[1].writeReceipt,'unknown');}
   assert.equal(await editor(page).innerText(),field==='sql'?'SELECT 2':batch);
   if(field!=='sql')assert.equal(await page.getByLabel(field==='summary'?'简介':field==='tags'?'标签':'标题',{exact:true}).inputValue(),field==='revert'?'before':'after');
   assert.equal((await page.getByText('结果来自修改前的内容',{exact:false}).count())>0,field==='sql');
   evidence.push({sourceId,scenario:'edit '+field+' during '+outcome+' execution',status:'PASS'});
  }
  await select(page,items[0].id,'Original');await page.evaluate(()=>{window.nextRun='defer';window.current.onRun();window.current.onRun()});
  const count=await page.evaluate(()=>window.executions);await editor(page).press('Control+Enter');assert.equal(await page.evaluate(()=>window.executions),count);
  await title(page).fill('Edited during run');await page.evaluate(()=>window.runs.at(-1).resolve());await page.waitForFunction(()=>!window.current.busy);
  await page.getByRole('button',{name:'更多查询操作',exact:true}).click();await page.getByRole('menuitem',{name:'保存',exact:true}).click();await page.waitForFunction(()=>!window.current.busy);
  let publishes=calls.filter(x=>x.action==='template-publish'&&x.connectionId===connectionId);
  assert.equal(publishes.at(-1).expectedVersion,1,'execution completion cannot advance save baseline');
  await title(page).fill('Second save');await page.getByRole('button',{name:'更多查询操作',exact:true}).click();await page.getByRole('menuitem',{name:'保存',exact:true}).click();await page.waitForFunction(()=>!window.current.busy);
  publishes=calls.filter(x=>x.action==='template-publish'&&x.connectionId===connectionId);assert.equal(publishes.at(-1).expectedVersion,2);
  evidence.push({sourceId,scenario:'synchronous duplicate and shortcut dispatch once; execution does not advance save baseline; consecutive saves use receipts',status:'PASS'});
  await run(page,'SELECT 1','defer');const prior=await page.evaluate(()=>window.runs.length-1);
  await page.evaluate(id=>window.changeConnection(id+'-other'),connectionId);await page.waitForFunction(id=>window.fixtureConnection===id+'-other'&&!window.current.busy,connectionId);await page.evaluate(id=>window.changeConnection(id),connectionId);await page.waitForFunction(id=>window.fixtureConnection===id&&!window.current.busy,connectionId);
  await run(page,'SELECT 2','defer');const current=await page.evaluate(()=>window.executions);
  await page.evaluate(prior=>window.runs[prior].resolve(),prior);await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.current.busy),true);
  await page.evaluate(()=>window.runs.at(-1).resolve());await page.waitForFunction(()=>!window.current.busy);await expectReceipt(page,current);
  evidence.push({sourceId,scenario:'connection A to B to A old cleanup cannot unlock new run',status:'PASS'});
  await run(page,'SELECT 1','defer');await page.evaluate(()=>{window.unmountApp();window.runs.at(-1).resolve()});await page.waitForTimeout(100);
  evidence.push({sourceId,scenario:'StrictMode unmount rejects late result',status:'PASS'});await page.close();
 }
 assert.deepEqual(pageErrors,[]);
 const report={status:evidence.some(x=>x.status==='FAIL')?'FAIL':'PASS',evidence,pageErrors,scope:'real SQL Hook and production controls; controlled execution bridge'};
 await writeFile(resolve(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 assert.deepEqual(evidence.filter(item=>item.status==='FAIL'),[], 'all execution-owner scenarios must satisfy correct behavior');
}catch(error){await writeFile(resolve(out,'result.json'),JSON.stringify({status:'FAIL',evidence,pageErrors,error:error.stack},null,2));throw error}
finally{await browser.close();await new Promise(done=>server.close(done))}

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { SqlTemplateStore } from '../src/host/sql-template-store.ts'
import { KnowledgeService } from '../src/host/knowledge-service.ts'

// Actual Hooks, production metadata fields and durable Host stores; only timing/failures are controlled.
const out = resolve('artifacts/ui/knowledge-terminal-retention')
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
import {RedisCommandEditor} from './src/client/redis/command-editor.tsx';
import {KafkaCommandEditor} from './src/client/kafka/editor.tsx';
import {RedisResultView} from './src/client/redis/result.tsx';
import {KafkaResultView} from './src/client/kafka/results.tsx';
import {connectionBridge} from './src/client/connection-bridge.ts';
const params=new URLSearchParams(location.search), sourceId=params.get('source');
const bridge={catalog:async()=>({items:[]}), execute:async(connection,sql,signal)=>{
 const mode=window.nextRun||'success';window.nextRun='success';
 const index=window.executions=(window.executions||0)+1;
 const result={columns:['proof'],rows:[['RECEIPT_MARKER_'+index]],elapsedMs:1,truncated:false};
 const partial=()=>Object.assign(Error('Controlled partial unknown'),{effect:'unknown',steps:[{index:0,sql:'INSERT INTO a VALUES (1)',status:'succeeded',affectedRows:1},{index:1,sql:'INSERT INTO b VALUES (2)',status:'unknown'},{index:2,sql:'INSERT INTO c VALUES (3)',status:'not-run'}],batch:[{columns:[],rows:[],elapsedMs:1,truncated:false,affectedRows:1}]});
 if(mode==='empty')return {...result,columns:[],rows:[],message:'EMPTY_RECEIPT_'+index};
 if(mode==='cancelled')throw Object.assign(Error('Controlled cancellation'),{effect:'none',requestPhase:'before-fetch'});
 if(mode==='failure')throw Object.assign(Error('Controlled execution failure'),{effect:'none',phase:'check'});
 if(mode==='partial')throw partial();
 if(mode==='defer'||mode==='stop-partial')return new Promise((resolve,reject)=>{
   (window.runs||=[]).push({resolve:()=>resolve(result),reject:()=>reject(Object.assign(Error('Controlled partial unknown'),{effect:'unknown'})),index,sql});
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
function Controls({view}){window.current=view;window.getSnapshot=()=>['mysql','oracle'].includes(sourceId)?view.execution?.props?.resultFrame?.props?.secondaryHeader?.props?.snapshot:view.executionInfo?.props?.children?.[1]?.props?.snapshot;return <>
 <KnowledgeLibrary sourceName={sourceId} items={view.items.map(item=>({...item,subtitle:item.subtitle||''}))} selectedId={view.selectedId} onSelect={view.select}
 search={view.search||''} onSearch={view.onSearch||view.setSearch} title={view.title} onTitle={view.setTitle} summary={view.summary} onSummary={view.setSummary}
 tags={view.tags} onTags={view.setTags} busy={view.busy} editorDisabled={view.editorDisabled} error={view.error} analysis={view.analysis} tidy={view.tidy} onSearchSubmit={view.onSearchSubmit} draftLabel="新建草稿"
 editor={view.editor} executionInfo={view.executionInfo} canRun={!!view.text} result={view.result?(sourceId==='redis'?<RedisResultView result={view.result}/>:<KafkaResultView result={view.result}/>):undefined} runError={view.runError} execution={['mysql','oracle'].includes(sourceId)&&params.get('run')==='1'?view.execution:undefined} onSave={view.save} onRun={view.onRun||view.tryRun} onUse={view.onUse||view.useForQuery} onArchive={view.onArchive||view.archive}/>
 <span id="error">{view.error}</span>
 </>}
const nativeFetch=window.fetch.bind(window);
window.fetch=(url,options)=>{
 if(!String(url).startsWith('/api/database/connections'))return nativeFetch(url,options);
 const mode=window.nextRun||'success';window.nextRun='success';const index=window.executions=(window.executions||0)+1;
 const request=outcome=>nativeFetch('/execution?source='+sourceId+'&index='+index+'&outcome='+outcome,options);
 if(mode==='defer')return new Promise(resolve=>(window.runs||=[]).push({resolve:()=>resolve(request('success')),reject:()=>resolve(request('failure')),businessFailure:()=>resolve(request('business-failure'))}));
 return request(mode);
};
const commandBridge=connectionBridge('fixture',bridge,true);
function Command({connection,active}){
 const [context,setContext]=useState('0');window.changeExecutionContext=setContext;
 const view=useKnowledgeLibrary(bridge,connection,active,(text,signal)=>commandBridge.executeText(connection,text,{database:context},signal),()=>{},context);
 const props={disabled:view.editorDisabled,value:view.text,onChange:view.setText,onRun:()=>void view.tryRun()};
 return <><select aria-label="执行 DB" value={context} onChange={e=>setContext(e.target.value)}><option>0</option><option>1</option></select>
 <Controls view={{...view,editor:sourceId==='redis'?<RedisCommandEditor {...props} onCursorChange={()=>{}}/>:<KafkaCommandEditor {...props}/>}}/></>
}
function Sql({connection,active}){const [cache]=useState(()=>new SchemaCache(bridge.catalog));const [schema,setSchema]=useState('app');window.changeSchema=setSchema;const props=useSqlKnowledge({active,bridge,connection,cache,schema,initialSql:params.get('run')==='1'?(params.get('initial')||''):'SELECT id, price FROM orders WHERE status = :status',onClose:()=>{},onSaved:id=>(window.savedIds??=[]).push(id)});return <Controls view={{...props,select:props.onSelect,save:props.onSave,setTitle:props.onTitle,setSummary:props.onSummary,setTags:props.onTags}}/>}
function App(){const [active,setActive]=useState(true);window.fixtureActive=active;window.changeActive=setActive;const [id,setId]=useState(params.get('connection'));const [generation,setGeneration]=useState('g1');window.changeGeneration=setGeneration;window.changeConnection=setId;const connection={id,generation,dialect:sourceId,live:params.get('run')==='1',environment:'sit'};return ['mysql','oracle'].includes(sourceId)?<Sql connection={connection} active={active}/>:<Command connection={connection} active={active}/>}
const appRoot=createRoot(document.getElementById('app'));window.unmountApp=()=>appRoot.unmount();appRoot.render(params.get('strict')==='1'?<React.StrictMode><App/></React.StrictMode>:<App/>);
` }, bundle: true, format: 'esm', outfile: resolve(out, 'fixture.js') })
const server = createServer(async (request, response) => {
  try {
    if(request.url.startsWith('/execution')){
      const params=new URL(request.url,'http://localhost').searchParams,source=params.get('source'),index=params.get('index'),outcome=params.get('outcome');
      const chunks=[];for await(const chunk of request)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString());
      const step={index:0,sql:input.input.text,status:outcome==='failure'?'unknown':outcome==='business-failure'?'failed':'succeeded'};
      const result=source==='redis'?{result:{type:'string',value:'RECEIPT_MARKER_'+index},elapsedMs:1,truncated:false,executionStatus:'succeeded',executionId:'run-'+index,steps:[step]}
       :{kind:'topics',topics:['RECEIPT_MARKER_'+index],executionStatus:'succeeded',executionId:'run-'+index,steps:[step]};
      if(outcome==='failure'){
        response.writeHead(409,{'Content-Type':'application/json'});
        response.end(JSON.stringify({error:'Controlled partial unknown',effect:'unknown',phase:'receipt',status:'unknown',executionId:'run-'+index,steps:[step],sourceResult:source==='kafka'?{kind:'produce-batch',topic:'probe',status:'unknown',executionStatus:'unknown',receipts:[{index:0,partition:0,baseOffset:'9007199254740993',valueBytes:1,acknowledged:true}],failedIndex:1,notSent:1}:undefined}));return;
      }
      response.setHeader('Content-Type','application/json');response.end(JSON.stringify(outcome==='business-failure'?{...result,executionStatus:'failed',message:'Controlled business failure'}:outcome==='cancelled'?{...result,executionStatus:'cancelled',message:'Controlled cancellation'}:outcome==='empty'?{...result,...(source==='redis'?{result:{type:'nil'}}:{topics:[]})}:result));return;
    }
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
const commandEditor=(page,sourceId)=>page.getByLabel(sourceId==='redis'?'Redis 命令':'Kafka 命令',{exact:true});
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

const edit=(page,source)=>page.getByLabel(source==='mysql'||source==='oracle'?'SQL 编辑器':source==='redis'?'Redis 命令':'Kafka 命令',{exact:true});
const start=(page,source)=>sqlSources.has(source)?page.locator('.db-sql-toolbar-btn').filter({hasText:/运行|执行选中/}).click():page.getByRole('button',{name:'试运行',exact:true}).click();
async function saveCurrent(page,source){if(sqlSources.has(source)){await page.getByRole('button',{name:'更多查询操作',exact:true}).click();await page.getByRole('menuitem',{name:'保存',exact:true}).click();}else await page.getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>!window.current.busy)}


try {
 for(const sourceId of ['redis','kafka','mysql','oracle']) for(const background of [false,true]) {
  const {page,connectionId,items}=await setup(sourceId,true);
  await select(page,items[0].id,'Original');
  const originalSummary=await page.evaluate(()=>window.current.summary);
  await page.evaluate(()=>window.nextRun='defer');await start(page,sourceId);
  const index=await page.evaluate(()=>window.executions);
  store.proposeTidy({connectionId,sourceId,changes:[{id:items[0].id,kind:'update',summary:'Approved while running'}]});
  await page.evaluate(()=>window.changeActive(false));await page.waitForFunction(()=>window.fixtureActive===false&&window.current.tidy.changes.length===0);
  await page.evaluate(()=>window.changeActive(true));await page.waitForFunction(()=>window.fixtureActive===true&&window.current.tidy.changes.length>0);
  await page.getByRole('button',{name:'全部通过',exact:true}).click();await page.waitForFunction(()=>window.current.tidy.notice.includes('已通过'));
  await page.waitForFunction(id=>window.current.items.some(x=>x.id===id&&x.summary==='Approved while running'),items[0].id);
  assert.equal(await page.evaluate(()=>window.current.summary),originalSummary);
  if(background)await select(page,items[1].id,'Other');
  await page.evaluate(()=>window.runs.at(-1).resolve());await page.waitForFunction(()=>!window.current.busy);
  if(!background)assert.ok((await page.locator('body').innerText()).includes('RECEIPT_MARKER_'+index));
  await select(page,items[0].id,'Original');
  const retained=(await page.locator('body').innerText()).includes('RECEIPT_MARKER_'+index);
  const summary=await page.evaluate(()=>window.current.summary);
  const recovery=await page.getByLabel('保留的草稿',{exact:true}).count();
  const record={sourceId,background,scenario:'approval during clean execution, reselect after terminal',retained,originalSummary,summary,recovery,status:retained?'PASS':'FAIL'};
  evidence.push(record);console.log(JSON.stringify(record));
  await page.close();
 }
 for(const sourceId of ['redis','kafka','mysql','oracle']) for(const scenario of ['no approval','dirty draft','unknown after approval']) {
  const {page,connectionId,items}=await setup(sourceId,true);
  await select(page,items[0].id,'Original');
  await page.evaluate(()=>window.nextRun='defer');await start(page,sourceId);
  const index=await page.evaluate(()=>window.executions);
  if(scenario!=='no approval'){
   store.proposeTidy({connectionId,sourceId,changes:[{id:items[0].id,kind:'update',summary:'Approved while running'}]});
   await page.evaluate(()=>window.changeActive(false));await page.waitForFunction(()=>window.fixtureActive===false&&window.current.tidy.changes.length===0);
   await page.evaluate(()=>window.changeActive(true));await page.waitForFunction(()=>window.fixtureActive===true&&window.current.tidy.changes.length>0);
   await page.getByRole('button',{name:'全部通过',exact:true}).click();await page.waitForFunction(()=>window.current.tidy.notice.includes('已通过'));
   await page.waitForFunction(id=>window.current.items.some(x=>x.id===id&&x.summary==='Approved while running'),items[0].id);
  }
  if(scenario==='dirty draft')await title(page).fill('Edited');
  await page.evaluate(unknown=>unknown?window.runs.at(-1).reject():window.runs.at(-1).resolve(),scenario==='unknown after approval');
  await page.waitForFunction(()=>!window.current.busy);
  const marker=scenario==='unknown after approval'?'Controlled partial unknown':'RECEIPT_MARKER_'+index;
  assert.ok((await page.locator('body').innerText()).includes(marker),'receipt must be displayed before reselect');
  await select(page,items[1].id,'Other');await select(page,items[0].id,scenario==='dirty draft'?'Edited':'Original');
  const retained=(await page.locator('body').innerText()).includes(marker);
  if(sourceId==='kafka'&&scenario==='unknown after approval'&&retained)assert.ok((await page.locator('body').innerText()).includes('9007199254740993'),'retain confirmed partial offsets alongside unknown');
  const record={sourceId,scenario,retained,status:retained?'PASS':'FAIL'};
  evidence.push(record);console.log(JSON.stringify(record));await page.close();
 }


 for(const sourceId of ['redis','kafka','mysql','oracle']) {
  const {page,connectionId,items}=await setup(sourceId,true);
  const original=items[0];await select(page,original.id,'Original');
  const snapshot=()=>page.evaluate(()=>window.getSnapshot());
  const visible=()=>page.locator('body').innerText();
  const record=scenario=>{const item={sourceId,scenario,status:'PASS'};evidence.push(item);console.log(JSON.stringify(item));};
  async function approve(summary){
   store.proposeTidy({connectionId,sourceId,changes:[{id:original.id,kind:'update',summary}]});
   await page.evaluate(()=>window.changeActive(false));await page.waitForFunction(()=>window.fixtureActive===false&&window.current.tidy.changes.length===0);
   await page.evaluate(()=>window.changeActive(true));await page.waitForFunction(()=>window.fixtureActive===true&&window.current.tidy.changes.length>0);
   await page.getByRole('button',{name:'全部通过',exact:true}).click();
   await page.waitForFunction(summary=>window.current.items.some(x=>x.summary===summary),summary);
   await page.waitForFunction(()=>!window.current.tidy.busy);
  }
  for(const [outcome,expected] of [['success','succeeded'],['failure','failed'],['cancelled','cancelled'],['empty','succeeded']]){
   await page.evaluate(mode=>window.nextRun=mode,outcome==='failure'&&!sqlSources.has(sourceId)?'business-failure':outcome);
   await start(page,sourceId);await page.waitForFunction(()=>!window.current.busy);
   assert.equal((await snapshot()).status,expected);
   await page.evaluate(()=>window.savedSnapshot=window.getSnapshot());
   const oldSummary=await page.evaluate(()=>window.current.summary);
   await approve('After terminal '+outcome);
   await select(page,items[1].id,'Other');await select(page,original.id,'Original');
   assert.equal(await page.evaluate(()=>window.getSnapshot()===window.savedSnapshot),true);
   assert.equal(await page.evaluate(()=>window.current.summary),oldSummary);
   assert.ok((await page.locator('#error').innerText()).includes('执行结果已保留'));
   await page.getByLabel('搜索经验库',{exact:true}).fill('Original');await page.getByLabel('搜索经验库',{exact:true}).press('Enter');
   await page.waitForFunction(()=>window.current.items.length===1);await select(page,original.id,'Original');
   assert.equal(await page.evaluate(()=>window.getSnapshot()===window.savedSnapshot),true);
   await page.getByLabel('搜索经验库',{exact:true}).fill('');await page.getByLabel('搜索经验库',{exact:true}).press('Enter');await page.waitForFunction(()=>window.current.items.length===2);
   record('terminal '+outcome+' survives later approval, filter and return without baseline change');
  }
  await saveCurrent(page,sourceId);assert.ok((await page.locator('#error').innerText()).includes('更新'));
  const publication=calls.filter(x=>x.connectionId===connectionId&&x.action.endsWith('-publish')).at(-1);
  assert.equal(publication.expectedVersion,original.version);record('retained clean execution keeps original save baseline and reports conflict');
  const retained=page.getByLabel('保留的草稿',{exact:true});
  await page.evaluate(()=>window.failGet=true);await page.getByRole('button',{name:/^重新加载/}).click();
  await page.waitForFunction(()=>window.current.editorDisabled&&window.current.error);
  assert.equal(await snapshot(),undefined);await retained.getByRole('button',{name:'恢复草稿与执行结果',exact:true}).waitFor();
  await page.evaluate(()=>window.delayGet=true);await page.getByRole('button',{name:'重新读取',exact:true}).click();await page.waitForFunction(()=>window.loadPending);
  await select(page,original.id);assert.equal(await page.evaluate(()=>window.current.editorDisabled),true,'reselect cannot bypass pending reload');
  await select(page,items[1].id,'Other');await page.evaluate(()=>window.releaseLoad());
  await page.waitForFunction(()=>!window.loadPending);assert.equal(await title(page).inputValue(),'Other');assert.equal(await snapshot(),undefined);
  await select(page,original.id,'Original');await page.waitForFunction(()=>!window.current.editorDisabled);
  assert.equal(await snapshot(),undefined);assert.equal(await retained.locator('p').count(),1);
  await retained.getByRole('button',{name:'恢复草稿与执行结果',exact:true}).click();
  assert.deepEqual(await snapshot(),await page.evaluate(()=>window.savedSnapshot));
  await saveCurrent(page,sourceId);assert.ok((await page.locator('#error').innerText()).includes('更新'));
  record('failed reload, delayed retry and navigation retain original execution and conflict baseline');
  for(let index=0;index<3;index++){
   await page.getByRole('button',{name:/^重新加载/}).click();await page.waitForFunction(()=>!window.current.editorDisabled);
   assert.equal(await snapshot(),undefined);assert.equal(await retained.locator('p').count(),1);
   await retained.getByRole('button',{name:'恢复草稿与执行结果',exact:true}).click();
   assert.equal((await snapshot()).status,'succeeded');
  }
  record('repeated clean reload and recovery keep one original token and its terminal snapshot');
  await title(page).fill('Dirty executed draft');await page.getByRole('button',{name:/^重新加载/}).click();await page.waitForFunction(()=>!window.current.editorDisabled);
  await retained.getByRole('button',{name:'恢复未保存草稿',exact:true}).click();
  assert.equal(await title(page).inputValue(),'Dirty executed draft');assert.equal((await snapshot()).status,'succeeded');
  record('dirty executed draft restores both metadata and execution result');
  await page.getByRole('button',{name:/^重新加载/}).click();await page.waitForFunction(()=>!window.current.editorDisabled);
  await approve('Clean automatic refresh');await select(page,original.id,'Original');
  assert.equal(await page.evaluate(()=>window.current.summary),'Clean automatic refresh');assert.equal(await snapshot(),undefined);
  record('clean unexecuted cached draft still refreshes to latest stored content');
  await select(page,items[1].id,'Other');await start(page,sourceId);await page.waitForFunction(()=>!window.current.busy);assert.ok(await snapshot());
  await page.evaluate(source=>source==='mysql'||source==='oracle'?window.changeSchema('other'):window.changeExecutionContext('1'),sourceId);
  await page.waitForFunction(()=>!window.getSnapshot());
  await page.evaluate(source=>source==='mysql'||source==='oracle'?window.changeSchema('app'):window.changeExecutionContext('0'),sourceId);
  await page.waitForFunction(()=>!window.current.busy);
  await retained.getByRole('button',{name:'恢复未保存草稿',exact:true}).click();
  assert.equal(await title(page).inputValue(),'Dirty executed draft');assert.equal(await snapshot(),undefined);
  assert.equal(await page.getByLabel('本次执行内容',{exact:true}).count(),0);
  record('target A to B to A clears active cached and retained execution facts while preserving text');
  await select(page,'','');await edit(page,sourceId).fill(sqlSources.has(sourceId)?'SELECT 7':sourceId==='redis'?'  GET new  ':'  TOPICS  ');await title(page).fill('  Normalized  ');await page.getByLabel('标签',{exact:true}).fill('tag, tag');
  await start(page,sourceId);await page.waitForFunction(()=>!window.current.busy);const firstIndex=await page.evaluate(()=>window.executions);
  const firstSnapshot=await snapshot();await saveCurrent(page,sourceId);
  assert.deepEqual(await snapshot(),firstSnapshot);const savedId=await page.evaluate(()=>window.current.selectedId);assert.ok(savedId);
  const stored=rows(sourceId,connectionId).find(x=>x.id===savedId);assert.ok(stored);await select(page,savedId,stored.title);assert.deepEqual(await snapshot(),firstSnapshot);assert.equal(await page.getByLabel('标签',{exact:true}).inputValue(),stored.tags.join(', '));assert.equal(stored.tags.filter(x=>x==='tag').length,1);assert.equal(await edit(page,sourceId).innerText(),stored.originalSql??stored.text);
  record('first save normalization and actual saved ID retain the same execution snapshot');
  await start(page,sourceId);await page.waitForFunction(()=>!window.current.busy);const nextIndex=await page.evaluate(()=>window.executions);
  assert.equal(nextIndex,firstIndex+1);assert.ok((await visible()).includes('RECEIPT_MARKER_'+nextIndex));
  assert.equal((await visible()).includes('RECEIPT_MARKER_'+firstIndex),false);
  record('next execution replaces only its draft previous result');await page.close();
 }


 for(const sourceId of ['mysql','oracle']) {
  const {page,connectionId,items}=await setup(sourceId,true);await select(page,items[0].id,'Original');
  await edit(page,sourceId).fill(batch);await saveCurrent(page,sourceId);const id=await page.evaluate(()=>window.current.selectedId);
  await page.evaluate(()=>window.nextRun='stop-partial');await start(page,sourceId);
  await page.locator('.db-sql-toolbar-btn').filter({hasText:'停止'}).click();await page.waitForFunction(()=>!window.current.busy);
  const before=await steps(page);assert.deepEqual(before.map(x=>x.status),['ok','unknown','skipped']);assert.equal(before[0].affectedRows,1);
  store.proposeTidy({connectionId,sourceId,changes:[{id,kind:'update',summary:'After stopped partial'}]});
  await page.evaluate(()=>window.changeActive(false));await page.waitForFunction(()=>window.fixtureActive===false);
  await page.evaluate(()=>window.changeActive(true));await page.getByRole('button',{name:'全部通过',exact:true}).click();
  await page.waitForFunction(()=>window.current.items.some(x=>x.summary==='After stopped partial'));
  await select(page,items[1].id,'Other');await select(page,id,'Original');assert.deepEqual(await steps(page),before);
  assert.equal(await page.evaluate(()=>window.getSnapshot().status),'unknown');
  evidence.push({sourceId,scenario:'stopped partial execution survives later approval and return with affected rows unknown and not-run steps',status:'PASS'});await page.close();
 }

 assert.deepEqual(pageErrors,[]);
 const failures=evidence.filter(x=>x.status==='FAIL');
 await writeFile(resolve(out,'result.json'),JSON.stringify({status:failures.length?'FAIL':'PASS',checks:evidence.length,evidence,pageErrors},null,2));
 assert.equal(failures.length,0,'execution facts must survive refreshed selection');
} catch(error) {
 await writeFile(resolve(out,'result.json'),JSON.stringify({status:'FAIL',checks:evidence.length,evidence,pageErrors,error:error.stack},null,2));throw error;
} finally {await browser.close();await new Promise(done=>server.close(done))}

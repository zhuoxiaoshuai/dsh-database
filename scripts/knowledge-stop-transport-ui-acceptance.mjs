import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { SqlTemplateStore } from '../src/host/sql-template-store.ts'
import { KnowledgeService } from '../src/host/knowledge-service.ts'

import {EventEmitter} from 'node:events'
import {ConnectionService} from '../src/host/connection-service.ts'
import {ExecutionStore} from '../src/host/execution-store.ts'
import {connectionApi} from '../src/host/connection-api.ts'
import {connectionInput} from '../test/helpers.mjs'
// Actual Hooks, production metadata fields and durable Host stores; only timing/failures are controlled.
const out = resolve('artifacts/ui/knowledge-stop-transport-ui')
await mkdir(out, { recursive: true })
const store = new SqlTemplateStore(await mkdtemp(resolve(out, 'store-'))), service = new KnowledgeService(store)
const sqlSources = new Set(['mysql', 'oracle']), sources = ['mysql', 'oracle', 'redis', 'kafka']
const calls = [], evidence = [], pageErrors = []
const hostRoot=await mkdtemp(resolve(out,'host-')), executions=new ExecutionStore(hostRoot);
let progressReady, activeWorker, hostErrors=[], dispatches=0;
class ControlledWorker extends EventEmitter{
 postMessage(message){
  if(message.cancel){queueMicrotask(()=>this.complete());return}
  if(!message.requestId){queueMicrotask(()=>this.emit('message',{ready:true,ok:true,result:{version:'fixture',database:'app',databases:['app'],health:'ready'}}));return}
  this.requestId=message.requestId;activeWorker=this;dispatches++;
  this.partial={steps:[{index:0,sql:'INSERT INTO a VALUES (1)',status:'succeeded',affectedRows:1},{index:1,sql:'INSERT INTO b VALUES (2)',status:'unknown'},{index:2,sql:'INSERT INTO c VALUES (3)',status:'not-run'}],batch:[{columns:[],rows:[],elapsedMs:1,truncated:false,affectedRows:1}]};
  queueMicrotask(()=>{this.emit('message',{requestId:this.requestId,sqlProgress:this.partial});progressReady?.()});
 }
 complete(){this.emit('message',{requestId:this.requestId,error:'Controlled stopped partial',effect:'unknown',phase:'receipt',...this.partial})}
 async terminate(){this.emit('exit',0);return 0}
}
const connectionService=new ConnectionService(()=>true,hostRoot,undefined,undefined,executions,undefined,()=>new ControlledWorker());
const request=connectionService.request.bind(connectionService);
connectionService.request=async(...args)=>{try{return await request(...args)}catch(error){hostErrors.push({message:error.message,steps:error.steps,effect:error.effect,batch:error.batch});throw error}};
const executeText=connectionService.executeText.bind(connectionService);
connectionService.executeText=async(...args)=>{try{return await executeText(...args)}catch(error){hostErrors.push({message:error.message,steps:error.steps,effect:error.effect,batch:error.batch});throw error}};
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
 if(['mysql','oracle'].includes(sourceId)){if(String(url).startsWith('/api/database/connections')&&JSON.parse(options?.body||'{}').action==='sql-knowledge-run'&&window.transportFault){const fault=window.transportFault;window.transportFault='';return nativeFetch(url,{...options,headers:{...options.headers,'X-Test-Knowledge-Fault':fault}});}return nativeFetch(url,options);}
 if(!String(url).startsWith('/api/database/connections'))return nativeFetch(url,options);
 const mode=window.nextRun||'success';window.nextRun='success';const index=window.executions=(window.executions||0)+1;
 const request=outcome=>nativeFetch('/execution?source='+sourceId+'&index='+index+'&outcome='+outcome,options);
 if(mode==='defer')return new Promise(resolve=>(window.runs||=[]).push({resolve:()=>resolve(request('success')),reject:()=>resolve(request('failure')),businessFailure:()=>resolve(request('business-failure'))}));
 return request(mode);
};
const commandBridge=connectionBridge('fixture',bridge,true);bridge.execute=(...args)=>commandBridge.executeManual(...args);bridge.executeKnowledge=(...args)=>commandBridge.executeKnowledge(...args);
function Command({connection,active}){
 const [context,setContext]=useState('0');window.changeExecutionContext=setContext;
 const view=useKnowledgeLibrary(bridge,connection,active,(text,signal)=>commandBridge.executeText(connection,text,{database:context},signal),()=>{},context);
 const props={disabled:view.editorDisabled,value:view.text,onChange:view.setText,onRun:()=>void view.tryRun()};
 return <><select aria-label="执行 DB" value={context} onChange={e=>setContext(e.target.value)}><option>0</option><option>1</option></select>
 <Controls view={{...view,editor:sourceId==='redis'?<RedisCommandEditor {...props} onCursorChange={()=>{}}/>:<KafkaCommandEditor {...props}/>}}/></>
}
function Sql({connection,active}){const [cache]=useState(()=>new SchemaCache(bridge.catalog));const [schema,setSchema]=useState('app');window.changeSchema=setSchema;const props=useSqlKnowledge({active,bridge,connection,cache,schema,initialSql:params.get('run')==='1'?(params.get('initial')||''):'SELECT id, price FROM orders WHERE status = :status',onClose:()=>{},onSaved:id=>(window.savedIds??=[]).push(id)});return <Controls view={{...props,select:props.onSelect,save:props.onSave,setTitle:props.onTitle,setSummary:props.onSummary,setTags:props.onTags}}/>}
function App(){const [active,setActive]=useState(true);window.fixtureActive=active;window.changeActive=setActive;const [id,setId]=useState(params.get('connection'));const [generation,setGeneration]=useState(params.get('generation')||'g1');window.changeGeneration=setGeneration;window.changeConnection=setId;const connection={id,generation,dialect:sourceId,live:params.get('run')==='1',environment:'sit'};return ['mysql','oracle'].includes(sourceId)?<Sql connection={connection} active={active}/>:<Command connection={connection} active={active}/>}
const appRoot=createRoot(document.getElementById('app'));window.unmountApp=()=>appRoot.unmount();appRoot.render(params.get('strict')==='1'?<React.StrictMode><App/></React.StrictMode>:<App/>);
` }, bundle: true, format: 'esm', outfile: resolve(out, 'fixture.js') })
const server = createServer(async (request, response) => {
  try {
    if(request.url.startsWith('/api/database/connections')){
      const fault=request.headers['x-test-knowledge-fault'];if(fault){const write=response.write.bind(response);response.write=(chunk,...args)=>{const frame=JSON.parse(String(chunk));if(fault==='accepted'&&frame.type==='accepted')return true;if(fault==='terminal'&&frame.type!=='accepted'){response.destroy();return false;}return write(chunk,...args);};}
      await connectionApi(connectionService,executions,'owner',request,response);return;}
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
  const connection=await connectionService.open('owner',connectionInput({dialect:sourceId,environment:'sit',name:'transport-'+(++serial)}),false);const connectionId=connection.id, items=[]
  for (const title of ['Original', 'Other']) items.push(sqlSources.has(sourceId)
    ? await store.publish({ dialect: sourceId, connectionId, action: 'create', title, sql: title === 'Original' ? 'SELECT id FROM orders' : 'SELECT amount FROM payments' })
    : store.publishKnowledge({ sourceId, connectionId, title, text: sourceId === 'redis' ? `GET ${title}` : title === 'Original' ? 'TOPICS' : 'GROUPS' }))
  await store.whenIdle()
  const page = await browser.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => pageErrors.push(error.message))
  console.log(`START ${connectionId}`)
  await page.goto(`http://127.0.0.1:${server.address().port}/?source=${sourceId}&connection=${connectionId}&generation=${connection.generation}&run=1&strict=${strict ? '1' : '0'}&initial=${encodeURIComponent(initial)}`)
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


try{
 for(const sourceId of ['mysql','oracle'])for(const stop of [false,true]){
  const {page}=await setup(sourceId,true);const record={sourceId,stop,status:'PASS'};
  try{
   await edit(page,sourceId).fill(batch);const gate=new Promise(resolve=>progressReady=resolve);const count=dispatches;
   await start(page,sourceId);await gate;
   if(stop)await page.locator('.db-sql-toolbar-btn').filter({hasText:'停止'}).click();else activeWorker.complete();
   await page.waitForFunction(()=>!window.current.busy);
   record.steps=await steps(page);record.snapshot=await page.evaluate(()=>window.getSnapshot());record.dispatches=dispatches-count;record.host=hostErrors.at(-1);
   assert.equal(record.dispatches,1,'no replay');
   assert.deepEqual(record.steps.map(x=>x.status),['ok','unknown','skipped'],'real HTTP stop must preserve Host-confirmed prefix and not-run suffix');
   assert.equal(record.steps[0].affectedRows,1);
  }catch(error){record.status='FAIL';record.error=error.message}
  finally{evidence.push(record);console.log(JSON.stringify(record));await page.close()}
 }
 for(const sourceId of ['mysql','oracle'])for(const scenario of ['switch owner and return','new draft and recover owner']){
  const {page,items}=await setup(sourceId,true);const record={sourceId,scenario,status:'PASS'};
  try{
   if(scenario==='switch owner and return')await select(page,items[0].id,'Original');await title(page).fill('Executing owner');await edit(page,sourceId).fill(batch);
   const gate=new Promise(resolve=>progressReady=resolve), count=dispatches;await start(page,sourceId);await gate;
   await edit(page,sourceId).fill(batch+' -- continued input');
   if(scenario==='switch owner and return'){await select(page,items[1].id,'Other');await title(page).fill('Other draft input');}
   else {await select(page,'','');await title(page).fill('New draft input');}
   await page.locator('.db-sql-toolbar-btn').filter({hasText:'停止'}).click();await page.waitForFunction(()=>!window.current.busy);
   assert.equal(await page.evaluate(()=>window.getSnapshot()),undefined,'background receipt must not appear on another draft');
   assert.equal(await title(page).inputValue(),scenario==='switch owner and return'?'Other draft input':'New draft input');
   if(scenario==='switch owner and return')await select(page,items[0].id,'Executing owner');
   else await page.getByLabel('保留的草稿',{exact:true}).locator('p').filter({hasText:'Executing owner'}).getByRole('button',{name:'恢复未保存草稿',exact:true}).click();
   assert.equal(await title(page).inputValue(),'Executing owner');assert.equal(await page.evaluate(()=>window.current.execution.props.sql),batch+' -- continued input');
   record.steps=await steps(page);record.snapshot=await page.evaluate(()=>window.getSnapshot());record.dispatches=dispatches-count;
   assert.deepEqual(record.steps.map(step=>step.status),['ok','unknown','skipped']);assert.equal(record.steps[0].affectedRows,1);
   assert.equal(record.snapshot.status,'unknown');assert.equal(record.dispatches,1);
   assert.deepEqual(hostErrors.at(-1).steps.map(step=>step.status),['succeeded','unknown','not-run']);
  }catch(error){record.status='FAIL';record.error=error.message}
  finally{evidence.push(record);console.log(JSON.stringify(record));await page.close()}
 }

 for(const sourceId of ['mysql','oracle'])for(const fault of ['accepted','terminal']){
  const {page}=await setup(sourceId,true);const record={sourceId,scenario:'real Host recovery after lost '+fault+' frame',status:'PASS'};
  try{
   await edit(page,sourceId).fill(batch);await page.evaluate(fault=>window.transportFault=fault,fault);
   const gate=new Promise(resolve=>progressReady=resolve),count=dispatches;await start(page,sourceId);await gate;
   if(fault==='terminal')await page.locator('.db-sql-toolbar-btn').filter({hasText:'停止'}).click();else activeWorker.complete();
   await page.waitForFunction(()=>!window.current.busy);
   record.steps=await steps(page);record.snapshot=await page.evaluate(()=>window.getSnapshot());record.dispatches=dispatches-count;
   assert.deepEqual(record.steps.map(step=>step.status),['ok','unknown','skipped']);assert.equal(record.steps[0].affectedRows,1);
   assert.equal(record.snapshot.status,'unknown');assert.equal(record.dispatches,1,'recovery reads cannot replay SQL');
  }catch(error){record.status='FAIL';record.error=error.message}
  finally{evidence.push(record);console.log(JSON.stringify(record));await page.close()}
 }

 assert.deepEqual(pageErrors,[]);
}finally{
 await writeFile(resolve(out,'result.json'),JSON.stringify({status:evidence.some(x=>x.status==='FAIL')?'FAIL':'PASS',checks:evidence.length,evidence,pageErrors},null,2));
 await browser.close();await connectionService.dispose();executions.dispose();await new Promise(done=>server.close(done));
}
if(evidence.some(x=>x.status==='FAIL'))process.exitCode=1;

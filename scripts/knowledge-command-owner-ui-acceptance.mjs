import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { SqlTemplateStore } from '../src/host/sql-template-store.ts'
import { KnowledgeService } from '../src/host/knowledge-service.ts'

// Actual Hooks, production metadata fields and durable Host stores; only timing/failures are controlled.
const out = resolve('artifacts/ui/knowledge-command-owner')
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
function Command({connection}){
 const [context,setContext]=useState('0');window.changeExecutionContext=setContext;
 const view=useKnowledgeLibrary(bridge,connection,true,(text,signal)=>commandBridge.executeText(connection,text,{database:context},signal),()=>{},context);
 const props={value:view.text,onChange:view.setText,onRun:()=>void view.tryRun()};
 return <><select aria-label="执行 DB" value={context} onChange={e=>setContext(e.target.value)}><option>0</option><option>1</option></select>
 <Controls view={{...view,editor:sourceId==='redis'?<RedisCommandEditor {...props} onCursorChange={()=>{}}/>:<KafkaCommandEditor {...props}/>}}/></>
}
function Sql({connection}){const [cache]=useState(()=>new SchemaCache(bridge.catalog));const [schema,setSchema]=useState('app');window.changeSchema=setSchema;const props=useSqlKnowledge({bridge,connection,cache,schema,initialSql:params.get('run')==='1'?(params.get('initial')||''):'SELECT id, price FROM orders WHERE status = :status',onClose:()=>{},onSaved:id=>(window.savedIds??=[]).push(id)});return <Controls view={{...props,select:props.onSelect,save:props.onSave,setTitle:props.onTitle,setSummary:props.onSummary,setTags:props.onTags}}/>}
function App(){const [id,setId]=useState(params.get('connection'));const [generation,setGeneration]=useState('g1');window.changeGeneration=setGeneration;window.changeConnection=setId;const connection={id,generation,dialect:sourceId,live:params.get('run')==='1',environment:'sit'};return ['mysql','oracle'].includes(sourceId)?<Sql connection={connection}/>:<Command connection={connection}/>}
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
      response.setHeader('Content-Type','application/json');response.end(JSON.stringify(outcome==='business-failure'?{...result,executionStatus:'failed',message:'Controlled business failure'}:result));return;
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

try {
 for(const sourceId of ['redis','kafka']) {
  for(const change of [false,true]) {
   for(const outcome of ['success','failure']) {
    const {page}=await setup(sourceId);
    await commandEditor(page,sourceId).fill(sourceId==='redis'?'GET probe':'TOPICS');
    await title(page).fill('before');
    await page.evaluate(()=>window.nextRun='defer');
    await page.getByRole('button',{name:'试运行',exact:true}).click();await page.waitForFunction(()=>window.runs?.length===1);
    if(change)await title(page).fill('after');
    await page.evaluate(outcome=>outcome==='success'?window.runs[0].resolve():window.runs[0].reject(),outcome);
    await page.waitForFunction(()=>!window.current.busy);
    assert.equal(await title(page).inputValue(),change?'after':'before');
    const actual=await page.evaluate(()=>({result:window.current.result,runError:window.current.runError}));
    const visible=(await page.locator('body').innerText()).includes(outcome==='success'?'RECEIPT_MARKER_1':'Controlled partial unknown');
    evidence.push({sourceId,scenario:(change?'edit title during ':'control without edit ')+outcome,actual,visible,status:visible?'PASS':'FAIL'});await page.close();
   }
  }
 }

 for(const sourceId of ['redis','kafka']) {
  const {page,items,connectionId}=await setup(sourceId,true);
  const text=sourceId==='redis'?'GET probe':'TOPICS';
  for(const field of ['text','title','summary','tags','revert'])for(const outcome of ['success','failure','business-failure']){
   await select(page,'','');await commandEditor(page,sourceId).fill(text);await title(page).fill('before');
   await page.evaluate(()=>window.nextRun='defer');await page.getByRole('button',{name:'试运行',exact:true}).click();
   const index=await page.evaluate(()=>window.executions);
   if(field==='text')await commandEditor(page,sourceId).fill(sourceId==='redis'?'GET changed':'GROUPS');
   else if(field==='revert'){await title(page).fill('temporary');await title(page).fill('before');}
   else await page.getByLabel(field==='summary'?'简介':field==='tags'?'标签':'标题',{exact:true}).fill('after');
   await page.evaluate(outcome=>{const run=window.runs.at(-1);outcome==='success'?run.resolve():outcome==='failure'?run.reject():run.businessFailure()},outcome);
   await page.waitForFunction(()=>!window.current.busy);
   if(outcome==='success')assert.ok((await page.locator('body').innerText()).includes('RECEIPT_MARKER_'+index));
   else assert.ok((await page.locator('body').innerText()).includes(outcome==='failure'?'Controlled partial unknown':'Controlled business failure'));
   if(field==='text')assert.ok((await page.locator('body').innerText()).includes('结果来自修改前的内容'));
   else assert.equal(await page.getByText('结果来自修改前的内容',{exact:false}).count(),0);
   if(sourceId==='kafka'&&outcome==='failure')assert.ok((await page.locator('body').innerText()).includes('9007199254740993'),'partial Kafka receipt remains visible beside error');
   assert.equal(await commandEditor(page,sourceId).innerText(),field==='text'?(sourceId==='redis'?'GET changed':'GROUPS'):text);
   if(field!=='text')assert.equal(await page.getByLabel(field==='summary'?'简介':field==='tags'?'标签':'标题',{exact:true}).inputValue(),field==='revert'?'before':'after');
   evidence.push({sourceId,scenario:'production editor '+field+' during '+outcome,status:'PASS'});
  }
  await select(page,items[0].id,'Original');await commandEditor(page,sourceId).fill(text);
  await page.evaluate(()=>{window.nextRun='defer';window.current.tryRun();window.current.tryRun()});
  const index=await page.evaluate(()=>window.executions);await commandEditor(page,sourceId).press('Control+Enter');
  assert.equal(await page.evaluate(()=>window.executions),index,'reentrant click/shortcut cannot dispatch twice');
  await select(page,items[1].id,'Other');await title(page).fill('Other typing');
  await page.evaluate(()=>window.runs.at(-1).resolve());await page.waitForFunction(()=>!window.current.busy);
  assert.equal(await page.getByText('RECEIPT_MARKER_'+index,{exact:true}).count(),0);
  await select(page,items[0].id,'Original');assert.ok((await page.locator('body').innerText()).includes('RECEIPT_MARKER_'+index));
  evidence.push({sourceId,scenario:'background run, other draft edits, return and synchronous duplicate run',status:'PASS'});
  await select(page,'','');await commandEditor(page,sourceId).fill(text);await title(page).fill('Retained owner');
  await page.evaluate(()=>window.nextRun='defer');await page.getByRole('button',{name:'试运行',exact:true}).click();const retainedIndex=await page.evaluate(()=>window.executions);
  await select(page,'','');await title(page).fill('Intermediate');await select(page,'','');
  await page.evaluate(()=>window.runs.at(-1).resolve());await page.waitForFunction(()=>!window.current.busy);
  await page.getByLabel('保留的草稿',{exact:true}).locator('p').filter({hasText:'Retained owner'}).getByRole('button').click();
  assert.ok((await page.locator('body').innerText()).includes('RECEIPT_MARKER_'+retainedIndex));
  evidence.push({sourceId,scenario:'multiple new drafts retain original execution receipt and restore it',status:'PASS'});
  await page.evaluate(()=>window.nextRun='defer');await page.getByRole('button',{name:'试运行',exact:true}).click();const old=await page.evaluate(()=>window.runs.length-1);
  await page.evaluate(()=>window.changeExecutionContext('1'));await page.waitForFunction(()=>!window.current.busy);await page.evaluate(()=>window.changeExecutionContext('0'));await page.waitForFunction(()=>!window.current.busy);
  assert.equal(await page.evaluate(()=>window.current.result),undefined);assert.equal(await page.evaluate(()=>window.current.runError),'');
  await page.evaluate(()=>window.nextRun='defer');await page.getByRole('button',{name:'试运行',exact:true}).click();
  const newIndex=await page.evaluate(()=>window.executions);await page.evaluate(old=>window.runs[old].resolve(),old);await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>window.current.busy),true);
  await page.evaluate(()=>window.runs.at(-1).resolve());await page.waitForFunction(()=>!window.current.busy);
  assert.ok((await page.locator('body').innerText()).includes('RECEIPT_MARKER_'+newIndex));
  evidence.push({sourceId,scenario:'execution context A to B to A clears results and stale cleanup cannot unlock current run',status:'PASS'});
  for(const kind of ['generation','connection']){
   await page.evaluate(()=>window.nextRun='defer');await page.getByRole('button',{name:'试运行',exact:true}).click();const old=await page.evaluate(()=>window.runs.length-1);
   await page.evaluate(({kind,id})=>kind==='generation'?window.changeGeneration('g2'):window.changeConnection(id+'-other'),{kind,id:connectionId});
   await page.waitForFunction(()=>!window.current.busy);assert.equal(await page.evaluate(()=>window.current.result),undefined);
   await commandEditor(page,sourceId).fill(text);await page.evaluate(()=>window.nextRun='defer');await page.getByRole('button',{name:'试运行',exact:true}).click();
   await page.evaluate(old=>window.runs[old].resolve(),old);await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.current.busy),true);
   await page.evaluate(()=>window.runs.at(-1).resolve());await page.waitForFunction(()=>!window.current.busy);
   evidence.push({sourceId,scenario:kind+' switch rejects prior execution and keeps new execution locked',status:'PASS'});
  }
  await page.evaluate(()=>window.nextRun='defer');await page.getByRole('button',{name:'试运行',exact:true}).click();await page.evaluate(()=>{window.unmountApp();window.runs.at(-1).resolve()});await page.waitForTimeout(100);
  evidence.push({sourceId,scenario:'StrictMode and unmount discard late execution response',status:'PASS'});await page.close();
 }
 assert.deepEqual(pageErrors,[]);await writeFile(resolve(out,'result.json'),JSON.stringify({status:evidence.some(x=>x.status==='FAIL')?'FAIL':'PASS',evidence,pageErrors,scope:'real command Hook, production Redis/Kafka editors and result views; actual connectionBridge HTTP parser and knowledge Host store; execution responses controlled'},null,2));console.log(JSON.stringify(evidence,null,2));
 assert.deepEqual(evidence.filter(item=>item.status==='FAIL'),[], 'all execution-owner scenarios must satisfy correct behavior');
}catch(error){await writeFile(resolve(out,'result.json'),JSON.stringify({status:'FAIL',evidence,pageErrors,error:error.stack},null,2));throw error}
finally{await browser.close();await new Promise(done=>server.close(done))}

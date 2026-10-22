import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const out = resolve('artifacts/ui/plugin-unification/after')
await mkdir(out, { recursive: true })
await build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
  import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
  import {StandardSourceMount} from './src/client/workspace-sources.tsx';import {clientModules} from './src/client/data-sources/registry.ts';
  import {useWorkbenchTheme} from './src/client/workspace/parts/theme/use-workbench-theme.ts';
  import {setWorkbenchTheme} from './src/client/workspace/parts/theme/workbench-theme.ts';import {workbenchThemes} from './src/client/workspace/parts/theme/theme-tokens.ts';
  import './src/client/style.css';
  import {WorkbenchShell} from './src/client/workspace/shell/workbench-shell.tsx';
  import {ConnectionForm} from './src/client/workspace/connection/connection-form.tsx';
  import {ExecutionWorkbench} from './src/client/workspace/source/execution-workbench.tsx';
  import {AiQueryFrame} from './src/client/ai-executions.tsx';
  import {ObjectHome} from './src/client/object-home.tsx';import {SchemaCache} from './src/client/schema/schema-cache.ts';
  import {KnowledgeLayout} from './src/client/workspace/knowledge/knowledge-layout.tsx';
  const calls=[],data={content:'port: 8080\\nname: app\\n',md5:'baseline',type:'yaml'},documents={};let source='kafka';
  const connections=Object.fromEntries(['mysql','oracle','kafka','redis','nacos'].map(dialect=>[dialect,{id:dialect,generation:'g1',name:dialect,dialect,environment:'sit',database:dialect==='redis'?'0':'',live:true,health:'ready'}]));
  const bridge={catalog:async(c,r)=>r.kind==='schemas'?{items:[{name:'app'}]}:r.kind==='tables'?{items:[{name:'demo',kind:'TABLE'}]}:{columns:[],indexes:[]},browse:async()=>({columns:['value'],rows:[['result']],elapsedMs:1}),testConnection:async()=>({version:'fixture',elapsedMs:1}),connect:async(input)=>({...connections[input.dialect],name:input.name}),tables:()=>[],execute:async()=>({}),executeText:async()=>({result:{type:'string',value:'PONG'}}),
    explorer:async(c,action,input)=>{calls.push({source:c.dialect,action,input});if(c.dialect==='redis'){if(action==='list')return {nodes:['sample:key','long:'+('resource-name-'.repeat(20))].map(title=>({ref:'key:'+encodeURIComponent(title),title,kind:'key'})),complete:true};return {keyType:'string',ttl:120,value:{result:{type:'string',value:'sample value'}}}}if(action==='list')return {nodes:[{ref:'topic:orders',title:'orders',kind:'topic'}],complete:true};return {kind:'topic',topic:'orders',partitions:[{partition:0,leader:1,replicas:[1,2],low:'0',high:'10'}]}},
    redis:async(c,action,input)=>{calls.push({source:c.dialect,action,input});if(action==='redis-scan')return {cursor:'0',keys:['sample:key','long:'+('resource-name-'.repeat(20))],complete:true};if(action==='redis-key')return {keyType:'string',ttl:120,value:{result:{type:'string',value:'sample value'}}};return {result:{type:'string',value:'OK'}}},
    executions:async(action,input)=>{if(action==='execution-wait'){await new Promise(r=>setTimeout(r,500));return {revision:0,items:[],events:[]}}if(action==='execution-document-get')return {document:documents[input.id]??={sourceId:source,text:'',context:source==='redis'?{database:'0'}:{},revision:1,controller:'ai'}};return {items:[]}},
    sourceRequest:async(c,action,input)=>{calls.push({source:c.dialect,action,input});switch(input.operation){case 'nacos-namespaces':return {items:[{namespace:'',namespaceShowName:'public'}]};case 'nacos-configs':return {items:[{dataId:'app.yaml',group:'G'}],total:1};case 'nacos-config':return {...data};case 'nacos-preview':return {kind:input.kind,before:data.content,after:input.content,previewToken:'fixture'};case 'nacos-services':return {items:[{name:'app',groupName:'G'}],total:1};case 'nacos-history':return {items:[],total:0};case 'nacos-listeners':return {listeners:{collectStatus:200,lisentersGroupkeyStatus:{}}};default:return {items:[]}}}}
  const cache=new SchemaCache(bridge.catalog);
  const record={events:[],dialect:'mysql',initiator:'user',type:'query',operation:'SELECT',executionId:'one',sourceId:'mysql',title:'执行记录',connectionId:'mysql',generation:'g1',connectionName:'mysql',status:'succeeded',createdAt:new Date().toISOString(),sql:'SELECT 1'};
  function App(){const theme=useWorkbenchTheme();const [dialect,setSource]=useState('kafka'),[form,setForm]=useState(false),[layout,setLayout]=useState('shell'),[key,setKey]=useState('');source=dialect;
    window.fixture={calls,setSource,setForm,setLayout,setResult:()=>setKey(String(Date.now())),setTheme:setWorkbenchTheme,custom:()=>{const base=workbenchThemes['mist-green'];workbenchThemes.test={...base,shared:{...base.shared,'--db-radius-control':'11px','--db-radius-panel':'12px','--db-radius-overlay':'14px','--db-border-width':'2px'},light:{...base.light,'--db-accent':'#536E87','--db-shadow':'0 2px 12px #536E8740'},dark:{...base.dark}};setWorkbenchTheme({paletteId:'test',mode:'light'})}};
    return <div className={'db-workbench'+(theme.dark?' db-dark':'')} {...theme.attributes} style={theme.style} data-instance="main">
    {layout==='shell'&&<WorkbenchShell key={dialect} bridge={bridge} conversationId="fixture" connection={connections[dialect]} connections={Object.values(connections)} onPick={id=>setSource(id)} onAdd={()=>setForm(true)} onEdit={()=>setForm(true)}/>}
    {layout==='split'&&<ExecutionWorkbench className="db-sql-run-workspace" resultKey={key} toolbar={<div className="db-catalog-tools">工具栏</div>} editor={<textarea aria-label="持久编辑内容" defaultValue="draft"/>} result={<div>执行结果</div>}/>}
    {layout==='ai'&&<AiQueryFrame label="AI布局" bridge={{...bridge,executions:async()=>record}} connection={connections.mysql} items={[record]} emptyNote="空"><textarea aria-label="AI内容" defaultValue="draft"/></AiQueryFrame>}
    {layout==='object'&&<ObjectHome schema="app" folder="table" objects={[{name:'demo',kind:'TABLE'}]} busy={false} highlight="demo" connection={connections.mysql} cache={cache} onHighlight={()=>{}} onOpen={()=>{}} onHint={()=>{}}/>}
    {layout==='knowledge'&&<KnowledgeLayout label="经验布局" className="db-knowledge-library" listHeader={<input aria-label="搜索经验"/>} listBody={<button className="db-template-list-main">经验一</button>}><textarea aria-label="经验内容" defaultValue="draft"/></KnowledgeLayout>}
    {form&&<ConnectionForm bridge={bridge} onClose={()=>setForm(false)} onConnected={()=>{}}/>}</div>}
  createRoot(document.getElementById('app')).render(<App/>);
` }, bundle: true, format: 'esm', outfile: resolve(out,'fixture.js') })

const html='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/fixture.css"><style>html,body,#app{height:100%;margin:0}</style></head><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>'
await writeFile(resolve(out,'index.html'),html)
const server=createServer(async(req,res)=>{const path=new URL(req.url,'http://fixture').pathname;const file=path==='/fixture.js'?'fixture.js':path==='/fixture.css'?'fixture.css':'index.html';res.setHeader('content-type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await readFile(resolve(out,file)))})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1200,height:850}}),errors=[],checks=[]
page.on('pageerror',e=>errors.push(e.message))
const root=page.locator('[data-instance=main]')
const resize=async width=>{await root.evaluate((el,width)=>el.style.width=width+'px',width);await page.waitForTimeout(70)}
const theme=async mode=>{await page.evaluate(mode=>window.fixture.setTheme({paletteId:'mist-green',mode}),mode);await page.waitForFunction(()=>document.getAnimations().every(a=>a.playState!=='running'))}
const overflow=async()=>assert.equal(await root.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'no outside horizontal overflow')
const layout=async name=>{await page.evaluate(name=>window.fixture.setLayout(name),name);await page.waitForTimeout(70)}
try{
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  for(const dialect of ['mysql','oracle','redis','kafka','nacos']){
    await page.evaluate(d=>window.fixture.setSource(d),dialect);await root.locator('.db-task-strip').waitFor()
    for(const width of [420,768,1200]){
      await resize(width)
      for(const mode of ['light','dark']){await theme(mode);await overflow();await root.screenshot({animations:'disabled',path:resolve(out,`${dialect}-${width}-${mode}.png`)})}
    }
  }
  for(const width of [979,980]){await resize(width);assert.equal(await root.getByRole('button',{name:'打开连接导航'}).isVisible(),width<980)}
  await resize(768);const trigger=root.getByRole('button',{name:'打开连接导航'});await trigger.click();await root.getByRole('button',{name:'关闭连接导航',exact:true}).last().waitFor();await page.keyboard.press('Escape');assert.equal(await trigger.evaluate(el=>el===document.activeElement),true)
  checks.push('five source mounts and shared shell at 420/768/1200, both modes; 979/980 container breakpoint and drawer focus')
  await resize(1200);await page.evaluate(()=>window.fixture.setSource('kafka'));await root.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByRole('menuitem',{name:'查询',exact:true}).click()
  const editor=root.getByRole('textbox',{name:'Kafka 命令',exact:true});await editor.fill('TOPICS draft');const identity=await editor.evaluate(el=>{window.editorNode=el;return true});await root.getByRole('tab',{name:'总览',exact:true}).click();await root.getByRole('tab',{name:'查询',exact:true}).click();assert.equal(await editor.evaluate(el=>el===window.editorNode),identity);assert.equal(await editor.innerText(),'TOPICS draft')
  await root.getByRole('tab',{name:'查询',exact:true}).press('Home');assert.equal(await root.getByRole('tab',{name:'总览',exact:true}).getAttribute('aria-selected'),'true')
  await root.getByRole('button',{name:'任务列表',exact:true}).click();await page.getByRole('menuitem',{name:'查询',exact:true}).click();await root.getByRole('tab',{name:'查询',exact:true}).waitFor()
  checks.push('task plus/overflow menus, keyboard activation and mounted command draft identity across task switches')
  await layout('split');const draft=root.getByLabel('持久编辑内容');await draft.fill('preserved text');await draft.evaluate(el=>window.draftNode=el)
  for(const width of [479,480]){await resize(width);assert.equal(await root.getByRole('tablist',{name:'编辑与结果'}).isVisible(),width<480)}
  await resize(1200);for(const height of [419,420]){await root.locator('.db-sql-split').evaluate((el,height)=>{el.style.height=height+'px';el.style.flex='none'},height);await page.waitForTimeout(70);assert.equal(await root.getByRole('tablist',{name:'编辑与结果'}).isVisible(),height<420)}
  await root.locator('.db-sql-split').evaluate(el=>{el.style.height='';el.style.flex=''});await resize(420);await page.evaluate(()=>window.fixture.setResult());await root.getByText('执行结果',{exact:true}).waitFor();await root.getByRole('tablist',{name:'编辑与结果'}).getByRole('tab',{name:'编辑',exact:true}).click();await resize(1200);await theme('dark');assert.equal(await draft.evaluate(el=>el===window.draftNode),true);assert.equal(await draft.inputValue(),'preserved text')
  checks.push('479/480 and 419/420 split breakpoints; execution selects result; return to edit preserves node and text')
  await layout('ai');await resize(1200);await root.locator('.db-ai-item-main').click()
  for(const width of [1119,1120]){await resize(width);assert.equal(await root.locator('.db-ai-executions').evaluate(el=>el.classList.contains('is-detail-overlay')),width<1120)}
  await resize(768);await page.keyboard.press('Escape');await resize(420);await root.getByRole('button',{name:'打开执行历史'}).click();await root.locator('.db-ai-item-main').click();await root.getByRole('button',{name:'关闭详情',exact:true}).waitFor();await page.keyboard.press('Escape');await overflow();await root.screenshot({path:resolve(out,'ai-420-dark.png')})
  checks.push('AI history drawer at narrow width and detail overlay at 1119/1120, Escape dismissal')
  await layout('object');for(const width of [759,760]){await resize(width);assert.equal(await root.getByRole('button',{name:'打开对象详情'}).isVisible(),width<760)}
  await resize(420);await root.getByRole('button',{name:'打开对象详情'}).click();await page.keyboard.press('Escape');assert.equal(await root.getByRole('button',{name:'打开对象详情'}).evaluate(el=>el===document.activeElement),true);await overflow();await root.screenshot({path:resolve(out,'object-420-dark.png')});checks.push('SQL object details remain available in a narrow drawer, focus restored, 759/760 breakpoint')
  await layout('knowledge');for(const width of [759,760]){await resize(width);assert.equal(await root.getByRole('button',{name:'打开经验列表'}).isVisible(),width<760)}
  await resize(420);await root.getByRole('button',{name:'打开经验列表'}).click();await root.getByRole('button',{name:'经验一',exact:true}).click();assert.equal(await root.getByRole('button',{name:'打开经验列表'}).getAttribute('aria-expanded'),'false');await overflow()
  checks.push('knowledge 759/760 container breakpoint and selection closes drawer')
  await layout('shell');await resize(768);await page.evaluate(()=>window.fixture.setForm(true));const dialog=root.getByRole('dialog',{name:'新建数据库连接'})
  for(const dialect of ['MySQL','Oracle','Redis','Kafka','Nacos']){
    await dialog.getByRole('button',{name:new RegExp(dialect)}).click();await dialog.getByRole('button',{name:'连接',exact:true}).waitFor();assert.equal(await dialog.locator('.db-primary').count(),1)
    for(const width of [420,768,1200]){await resize(width);for(const mode of ['light','dark']){await theme(mode);await overflow();assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);await root.screenshot({path:resolve(out,`connection-${dialect}-${width}-${mode}.png`),animations:'disabled'})}}
    if(['Redis','Kafka','Nacos'].includes(dialect)){assert.equal(await dialog.locator('details').getAttribute('open'),null);await dialog.locator('summary').click();assert.notEqual(await dialog.locator('details').getAttribute('open'),null)}
    await dialog.getByRole('button',{name:'上一步'}).click()
  }
  await dialog.getByRole('button',{name:/Redis/}).click();await dialog.getByLabel('主机地址',{exact:true}).fill('localhost');await dialog.getByRole('button',{name:'测试连接',exact:true}).click();await dialog.getByText(/连接测试成功/).waitFor();await dialog.getByRole('button',{name:'密码保存说明'}).click();await page.evaluate(()=>window.fixture.custom());assert.equal(await page.getByRole('dialog',{name:'密码保存说明'}).evaluate(el=>getComputedStyle(el).borderRadius),'14px');assert.equal(await dialog.getByRole('button',{name:'连接',exact:true}).evaluate(el=>getComputedStyle(el).borderRadius),'11px');assert.equal(await dialog.evaluate(el=>getComputedStyle(el).borderTopWidth),'2px')
  checks.push('five stepped forms at three sizes and both modes; one primary action, collapsed advanced settings, test flow and custom geometry on open help/dialog/button')
  assert.deepEqual(errors,[]);const report={status:'PASS',checks,pageErrors:errors,realServices:'NOT_RUN',installedDesktop:'NOT_RUN'};await writeFile(resolve(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
}catch(error){console.error(JSON.stringify({pageErrors:errors}));await page.screenshot({path:resolve(out,'failure.png')});throw error}finally{await browser.close();await new Promise(done=>server.close(done))}

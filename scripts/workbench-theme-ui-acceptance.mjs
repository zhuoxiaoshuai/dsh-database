import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const out = resolve('artifacts/ui/theme-review')
await mkdir(out, { recursive: true })
await build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
  import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
  import {StandardSourceMount} from './src/client/workspace-sources.tsx';import {clientModules} from './src/client/data-sources/registry.ts';
  import {useWorkbenchTheme} from './src/client/workspace/parts/theme/use-workbench-theme.ts';
  import {setWorkbenchTheme} from './src/client/workspace/parts/theme/workbench-theme.ts';import {workbenchThemes} from './src/client/workspace/parts/theme/theme-tokens.ts';
  import './src/client/style.css';
  const calls=[],data={content:'port: 8080\\nname: app\\n',md5:'baseline',type:'yaml'},documents={};let source='kafka';
  const connections=Object.fromEntries(['kafka','redis','nacos'].map(dialect=>[dialect,{id:dialect,generation:'g1',name:dialect,dialect,environment:'sit',database:dialect==='redis'?'0':'',live:true,health:'ready'}]));
  const bridge={tables:()=>[],execute:async()=>({}),executeText:async()=>({result:{type:'string',value:'PONG'}}),
    explorer:async(c,action,input)=>{calls.push({source:c.dialect,action,input});if(c.dialect==='redis'){if(action==='list')return {nodes:['sample:key','long:'+('resource-name-'.repeat(20))].map(title=>({ref:'key:'+encodeURIComponent(title),title,kind:'key'})),complete:true};return {keyType:'string',ttl:120,value:{result:{type:'string',value:'sample value'}}}}if(action==='list')return {nodes:[{ref:'topic:orders',title:'orders',kind:'topic'}],complete:true};return {kind:'topic',topic:'orders',partitions:[{partition:0,leader:1,replicas:[1,2],low:'0',high:'10'}]}},
    redis:async(c,action,input)=>{calls.push({source:c.dialect,action,input});if(action==='redis-scan')return {cursor:'0',keys:['sample:key','long:'+('resource-name-'.repeat(20))],complete:true};if(action==='redis-key')return {keyType:'string',ttl:120,value:{result:{type:'string',value:'sample value'}}};return {result:{type:'string',value:'OK'}}},
    executions:async(action,input)=>{if(action==='execution-wait'){await new Promise(r=>setTimeout(r,500));return {revision:0,items:[],events:[]}}if(action==='execution-document-get')return {document:documents[input.id]??={sourceId:source,text:'',context:source==='redis'?{database:'0'}:{},revision:1,controller:'ai'}};return {items:[]}},
    sourceRequest:async(c,action,input)=>{calls.push({source:c.dialect,action,input});switch(input.operation){case 'nacos-namespaces':return {items:[{namespace:'',namespaceShowName:'public'}]};case 'nacos-configs':return {items:[{dataId:'app.yaml',group:'G'}],total:1};case 'nacos-config':return {...data};case 'nacos-preview':return {kind:input.kind,before:data.content,after:input.content,previewToken:'fixture'};case 'nacos-services':return {items:[{name:'app',groupName:'G'}],total:1};case 'nacos-history':return {items:[],total:0};case 'nacos-listeners':return {listeners:{collectStatus:200,lisentersGroupkeyStatus:{}}};default:return {items:[]}}}}
  function Mount({dialect,second=false}){const theme=useWorkbenchTheme();return <div className={'db-workbench'+(theme.dark?' db-dark':'')} {...theme.attributes} style={{...theme.style,...(second?{position:'absolute',left:-2000,width:500,height:700}:{height:'100%'})}} data-instance={second?'second':'main'}><StandardSourceMount module={clientModules.get(dialect)} context={{host:bridge,connection:connections[dialect],connections:Object.values(connections),catalogRoot:dialect==='redis'?'0':dialect==='kafka'?'topics':'',refreshToken:0,conversationId:second?'second':'fixture'}}/></div>}
  function App(){const [dialect,setSource]=useState('kafka'),[second,setSecond]=useState(false);source=dialect;window.fixture={calls,data,setSource,setSecond,setTheme:setWorkbenchTheme,custom:()=>{const base=workbenchThemes['mist-green'];workbenchThemes.test={...base,name:'Test only',shared:{...base.shared,'--db-radius-control':'9px','--db-radius-overlay':'13px'},light:{...base.light,'--db-panel':'#F7F8FC','--db-overlay-panel':'#F0F3FA','--db-accent':'#536E87','--db-sql-keyword':'#734B79','--db-line':'#BCCADD','--db-control-line':'#647890','--db-diff-add':'#D8E6F2'},dark:{...base.dark}};setWorkbenchTheme({paletteId:'test',mode:'light'})}};return <><Mount key={dialect} dialect={dialect}/>{second&&<Mount dialect={dialect} second/>}</>}
  createRoot(document.getElementById('app')).render(<App/>);
` }, bundle: true, format: 'esm', outfile: resolve(out,'fixture.js') })

const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/fixture.css"><style>html,body,#app{height:100%;margin:0}</style></head><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>'
await writeFile(resolve(out,'index.html'),html)
const server = createServer(async (req,res) => {
  const path = new URL(req.url,'http://fixture').pathname
  const comparison=path.match(/^\/comparison\/(before|after)\/(.*)$/)
  if(comparison){
    const folder=comparison[1]==='before'?resolve(out,'before/kafka'):resolve('artifacts/ui/kafka-catalog-tree')
    const name=comparison[2]||'index.html'
    try {
      let body=await readFile(resolve(folder,name),'utf8')
      if(name==='index.html')body=body.replaceAll('/fixture.',`/comparison/${comparison[1]}/fixture.`)
      // Expose only the controlled fixture bridge, so identical Redis data can
      // be supplied to the preserved old bundle and the current bundle.
      if(name==='fixture.js')body=body.replace('function Fixture() {',`bridge.explorer=async(c,action)=>action==='list'?{nodes:[{ref:'key:sample%3Akey',title:'sample:key',kind:'key'}],complete:true}:{keyType:'string',ttl:120,value:{result:{type:'string',value:'sample value'}}};bridge.redis=async(c,action)=>action==='redis-scan'?{cursor:'0',keys:['sample:key'],complete:true}:{keyType:'string',ttl:120,value:{result:{type:'string',value:'sample value'}}};function Fixture() {`)
      res.setHeader('content-type',name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(body)
    }catch{res.writeHead(404);res.end()}
    return
  }
  const beforePage = path.match(/^\/before\/(kafka|nacos)\/$/)
  if (beforePage) { res.setHeader('content-type','text/html');res.end(html.replaceAll('/fixture.',`/before/${beforePage[1]}/fixture.`));return }
  const before = path.match(/^\/before\/(kafka|nacos)\/(fixture\.(js|css))$/)
  const file = before ? resolve(out,`before/${before[1]}/${before[2]}`) : resolve(out,path==='/fixture.js'?'fixture.js':path==='/fixture.css'?'fixture.css':'index.html')
  try { res.setHeader('content-type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await readFile(file)) }
  catch {res.writeHead(404);res.end()}
})
await new Promise(done => server.listen(0,'127.0.0.1',done))
const browser=await chromium.launch({channel:'msedge',headless:true})
const page=await browser.newPage({viewport:{width:1200,height:850}}),errors=[],checks=[]
page.on('pageerror',error=>errors.push(error.message))
const origin=`http://127.0.0.1:${server.address().port}`
const main=page.locator('[data-instance=main]')
const source=async dialect=>{await page.evaluate(d=>window.fixture.setSource(d),dialect);await main.getByLabel(dialect==='kafka'?'Kafka 工作区':dialect==='redis'?'Redis 工作区':'Nacos 工作区',{exact:true}).waitFor()}
const drawer=async label=>{const button=main.getByRole('button',{name:label,exact:true});if(await button.isVisible())await button.click()}
const theme=async mode=>{await page.evaluate(mode=>window.fixture.setTheme({paletteId:'mist-green',mode}),mode);await page.waitForFunction(mode=>document.querySelector('[data-instance=main]').dataset.dbScheme===mode,mode);await page.waitForFunction(()=>document.getAnimations().every(animation=>animation.playState!=='running'))}
const noOverflow=async()=>assert.equal(await main.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'outer workspace does not overflow')
try {
  await page.goto(origin)
  await main.getByRole('button',{name:'orders',exact:true}).click()
  await main.getByRole('columnheader',{name:'副本',exact:true}).waitFor()
  // Content-container breakpoints, both schemes and matching screenshots for all sources.
  for(const dialect of ['kafka','redis','nacos']){
    await source(dialect)
    if(dialect==='kafka'){await drawer('打开 Topic 列表');await main.getByRole('button',{name:'orders',exact:true}).click()}
    if(dialect==='redis'){await drawer('打开 Key 列表');await main.locator('button[title="sample:key"]').click();await main.getByLabel('String 值',{exact:true}).waitFor()}
    for(const width of [420,768,1200]){
      await page.setViewportSize({width,height:850})
      for(const mode of ['light','dark']){await theme(mode);await noOverflow();await page.screenshot({animations:'disabled',path:resolve(out,`${dialect}-${width}-${mode}.png`)})}
    }
    if(dialect!=='nacos'){
      // Kafka 同时常驻 topics/groups 两个概览（data-sources/kafka.tsx 的 keep-alive 隐藏挂载），
      // 两个 .db-search-tree-toggle 同时在 DOM 中；断言必须限定到当前激活面板的抽屉开关。
      const treeDrawer=dialect==='kafka'?'打开 Topic 列表':'打开 Key 列表'
      for(const width of [759,760]){await page.setViewportSize({width,height:850});assert.equal(await main.getByRole('button',{name:treeDrawer,exact:true}).isVisible(),width<760)}
      await page.setViewportSize({width:600,height:850});await drawer(treeDrawer);await page.keyboard.press('Escape');await page.waitForFunction(()=>document.activeElement?.classList.contains('db-search-tree-toggle'))
    }
  }
  checks.push('three sources at 420/768/1200 in light/dark, container breakpoints and drawer focus')
  await page.setViewportSize({width:1200,height:850});await theme('light')
  await source('redis');await main.locator('button[title="sample:key"]').click();const value=main.getByLabel('String 值',{exact:true})
  await value.fill('draft survives theme');await value.evaluate(el=>{el.selectionStart=3;el.selectionEnd=8;el.scrollTop=10})
  const beforeRedis=await value.evaluate(el=>({value:el.value,start:el.selectionStart,end:el.selectionEnd,scroll:el.scrollTop}))
  await main.getByRole('button',{name:'更多 Key 操作'}).click();await page.getByRole('menuitem',{name:'修改 TTL'}).click();await main.getByLabel('TTL 秒数').fill('300')
  const callCount=await page.evaluate(()=>window.fixture.calls.length)
  await main.getByRole('button',{name:'更多 Key 操作'}).click();await theme('dark')
  assert.equal(await page.getByRole('menu',{name:'更多 Key 操作'}).getAttribute('data-db-scheme'),'dark')
  assert.deepEqual(await value.evaluate(el=>({value:el.value,start:el.selectionStart,end:el.selectionEnd,scroll:el.scrollTop})),beforeRedis)
  assert.equal(await main.getByLabel('TTL 秒数').inputValue(),'300')
  assert.equal(await page.evaluate(()=>window.fixture.calls.length),callCount)
  await page.keyboard.press('Escape')
  await main.getByRole('button',{name:'更多 Key 操作'}).click();await page.getByRole('menuitem',{name:'删除',exact:true}).click();const deleteDialog=main.getByRole('dialog',{name:'删除 Key'});await deleteDialog.waitFor();assert.match(await deleteDialog.innerText(),/sample:key/);await deleteDialog.getByRole('button',{name:'取消',exact:true}).click()
  checks.push('Redis value selection, TTL draft and open menu survive theme; delete still confirms')
  await source('nacos');await main.getByRole('button',{name:'编辑',exact:true}).click();const editor=main.getByLabel('Nacos 配置正文',{exact:true})
  await editor.click();await page.keyboard.press('Control+End');await page.keyboard.insertText('# unsaved')
  await page.evaluate(()=>{window.fixture.editor=document.querySelector('.db-nacos-editor .cm-editor');window.fixture.scroller=document.querySelector('.db-nacos-editor .cm-scroller');window.fixture.scroller.scrollTop=12})
  const configText=await editor.innerText(),configCalls=await page.evaluate(()=>window.fixture.calls.length)
  await theme('light');await theme('dark');assert.equal(await editor.innerText(),configText)
  assert.equal(await page.evaluate(()=>window.fixture.editor===document.querySelector('.db-nacos-editor .cm-editor')),true)
  assert.equal(await page.evaluate(()=>window.fixture.calls.length),configCalls)
  await editor.click();await page.keyboard.press('Control+z');assert.doesNotMatch(await editor.innerText(),/# unsaved/)
  await main.getByRole('button',{name:'预览发布'}).click();await page.getByRole('dialog',{name:'确认配置变更'}).waitFor()
  await theme('light');await page.evaluate(()=>window.fixture.custom())
  await page.waitForFunction(()=>document.querySelector('[data-instance=main]').dataset.dbPalette==='test')
  assert.equal(await main.getByRole('button',{name:'预览发布'}).evaluate(el=>getComputedStyle(el).borderRadius),'9px')
  assert.equal(await main.evaluate(el=>getComputedStyle(el).getPropertyValue('--db-line').trim()),'#BCCADD')
  assert.equal(await page.locator('.db-nacos-diff').evaluate(el=>getComputedStyle(el).getPropertyValue('--db-diff-add').trim()),'#D8E6F2')
  await page.screenshot({animations:'disabled',path:resolve(out,'nacos-custom-diff.png')});await page.getByRole('button',{name:'取消',exact:true}).click()
  assert.ok(await main.locator('.db-nacos-editor').evaluate(el=>el.clientHeight)>400,'editor gets remaining height')
  await main.getByRole('button',{name:'更多配置操作'}).click();await page.evaluate(()=>window.fixture.custom())
  assert.equal(await page.getByRole('menu',{name:'更多配置操作'}).evaluate(el=>getComputedStyle(el).borderRadius),'13px')
  await page.keyboard.press('Escape');checks.push('Nacos editor identity, undo and drafts preserved; custom palette reaches controls, border, Diff and open popover')
  await page.evaluate(()=>window.fixture.setSecond(true));await page.locator('[data-instance=second]').waitFor();await theme('dark')
  assert.deepEqual(await page.locator('[data-instance]').evaluateAll(els=>els.map(el=>el.dataset.dbScheme)),['dark','dark'])
  await page.evaluate(()=>{document.documentElement.dataset.theme='light';window.fixture.setTheme({paletteId:'mist-green',mode:'host'})});await page.waitForFunction(()=>document.querySelector('[data-instance=main]').dataset.dbScheme==='light')
  await page.emulateMedia({colorScheme:'dark'});assert.equal(await main.getAttribute('data-db-scheme'),'light')
  await page.evaluate(()=>{document.documentElement.dataset.theme='dark'});await page.waitForFunction(()=>document.querySelector('[data-instance=main]').dataset.dbScheme==='dark')
  await page.evaluate(()=>{document.documentElement.dataset.theme='light'});await page.waitForFunction(()=>document.querySelector('[data-instance=main]').dataset.dbScheme==='light')
  await page.evaluate(()=>window.fixture.setSecond(false));await theme('dark');await page.reload();await page.waitForFunction(()=>document.querySelector('[data-instance=main]')?.dataset.dbScheme==='dark')
  checks.push('multiple instances, explicit host light over system dark, live host changes and persisted mode')
  await source('kafka');await main.getByRole('tab',{name:'查询',exact:true}).click();const command=main.getByLabel('Kafka 命令',{exact:true})
  await command.fill('TO');await command.press('Control+Shift+Space');await page.locator('.cm-tooltip-autocomplete').waitFor({state:'visible'})
  await theme('light');assert.equal(await page.locator('.cm-tooltip-autocomplete').evaluate(el=>getComputedStyle(el).getPropertyValue('--db-accent').trim()),'#496C5D')
  await page.evaluate(()=>window.fixture.custom());assert.equal(await page.locator('.cm-tooltip-autocomplete').evaluate(el=>getComputedStyle(el).getPropertyValue('--db-accent').trim()),'#536E87')
  await page.keyboard.press('Escape');checks.push('already open CodeMirror completion follows palette without recreating editor')
  // These compiled bundles were preserved before implementation; capture at the same
  // dimensions as the existing current-source Kafka and Nacos acceptance screenshots.
  const hasBaseline=await readFile(resolve(out,'before/kafka/fixture.js')).then(()=>true,()=>false)
  if(hasBaseline){
  const baseline=await browser.newPage({viewport:{width:1280,height:800}})
  try {
    await baseline.goto(origin+'/before/kafka/')
    await baseline.getByRole('button',{name:'orders',exact:true}).click()
    await baseline.getByRole('columnheader',{name:'副本',exact:true}).waitFor()
    await baseline.screenshot({animations:'disabled',path:resolve(out,'before/kafka-1280-light.png')})
    await baseline.locator('.db-workbench').evaluate(el=>el.classList.add('db-dark'))
    await baseline.screenshot({animations:'disabled',path:resolve(out,'before/kafka-1280-dark.png')})
    await baseline.setViewportSize({width:1200,height:850});await baseline.goto(origin+'/before/nacos/')
    await baseline.getByRole('button',{name:'编辑',exact:true}).waitFor()
    await baseline.getByRole('textbox',{name:'Group',exact:true}).fill('G');await baseline.getByRole('textbox',{name:'资源名称',exact:true}).fill('app')
    await baseline.getByRole('button',{name:'搜索',exact:true}).click();await baseline.getByRole('cell',{name:'app.yaml',exact:true}).waitFor()
    await baseline.screenshot({animations:'disabled',path:resolve(out,'before/nacos-1200-light.png')})
    await baseline.locator('.db-workbench').evaluate(el=>el.classList.add('db-dark'))
    await baseline.screenshot({animations:'disabled',path:resolve(out,'before/nacos-1200-dark.png')})
  } finally {await baseline.close()}
  const comparison=await browser.newPage({viewport:{width:1280,height:800}})
  try {
    for(const version of ['before','after']){
      await comparison.goto(origin+`/comparison/${version}/`)
      await comparison.locator('.db-conn-tree .db-schema-node').filter({hasText:'db0'}).click()
      await comparison.locator('button[title="sample:key"]').click();await comparison.getByLabel('String 值',{exact:true}).waitFor()
      for(const mode of ['light','dark']){
        await comparison.locator('.db-workbench').evaluate((el,dark)=>el.classList.toggle('db-dark',dark),mode==='dark')
        await comparison.screenshot({animations:'disabled',path:resolve(out,version==='before'?`before/redis-1280-${mode}.png`:`redis-1280-${mode}.png`)})
      }
    }
  }catch(error){await comparison.screenshot({animations:'disabled',path:resolve(out,'comparison-failure.png')});throw error}finally{await comparison.close()}
  }
  assert.deepEqual(errors,[])
  const result={status:'PASS',evidence:'controlled source fixtures and actual client components; no real databases',checks,pageErrors:errors}
  await writeFile(resolve(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
} catch(error){await page.screenshot({animations:'disabled',path:resolve(out,'failure.png')});throw error}
finally {await browser.close();await new Promise(done=>server.close(done))}

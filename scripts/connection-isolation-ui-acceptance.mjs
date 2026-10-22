import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {EventEmitter} from 'node:events'
import {mkdir, readFile, writeFile, mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {build} from 'esbuild'
import {chromium} from 'playwright'
import {ConnectionService} from '../src/host/connection-service.ts'
import {ExecutionStore} from '../src/host/execution-store.ts'
import {connectionApi} from '../src/host/connection-api.ts'
import {memoryPasswordProtector} from '../src/host/saved-connections.ts'

// Actual workbench, HTTP handlers and lifecycle service; only database handshakes are controlled.
const outdir = resolve('artifacts/ui/connection-isolation')
await mkdir(outdir, {recursive:true})
await build({stdin:{resolveDir:resolve('.'),sourcefile:'connection-isolation.tsx',loader:'tsx',contents:`
  import React, {useState} from 'react'
  import {createRoot} from 'react-dom/client'
  import {DatabaseWorkspace} from './src/client/workspace/shell/database-workspace.tsx'
  import {databaseCss} from './src/client/style-css.ts'
  document.head.appendChild(Object.assign(document.createElement('style'), {textContent:databaseCss}))
  function App() {const [active,setActive] = useState(''); const [owner,setOwner] = useState('fixture'); return <><button onClick={()=>setOwner('fixture')}>对话 A</button><button onClick={()=>setOwner('other')}>对话 B</button><output id="active">{active}</output><div style={{height:760}}><DatabaseWorkspace conversationId={owner} preview onActive={setActive}/></div></>}
  createRoot(document.getElementById('app')).render(<App/>)
`},bundle:true,format:'esm',outdir,entryNames:'fixture'})
await writeFile(join(outdir,'index.html'), '<!doctype html><meta charset="utf-8"><div id="app"></div><script type="module" src="/fixture.js"></script>')
const directory = await mkdtemp(join(tmpdir(),'dsh-connection-ui-'))
const workers = [], gates = new Map(), dispatched = []
class FixtureWorker extends EventEmitter {
  terminated = false
  postMessage(message) {
    if (message.cancel) {this.emit('message',{requestId:message.requestId,cancelled:true,error:'读取已取消。'}); return}
    if (!message.requestId) {
      this.name = message.input.name
      const reply = () => this.emit('message', {ready:true,result:{version:'controlled-fixture',database:'0',databases:['0'],elapsedMs:1}})
      if (this.name.startsWith('slow')) gates.set(this.name,reply)
      else if (this.name === 'failed') queueMicrotask(() => this.emit('message',{ready:false,error:'WRONGPASS',category:'authentication'}))
      else queueMicrotask(reply)
    } else {
      dispatched.push({name:this.name, action:message.action})
      queueMicrotask(() => this.emit('message',{requestId:message.requestId,health:'ready',result:message.action === 'redis-command' ? {result:{type:'string',value:'PONG'},elapsedMs:1} : {keys:[],items:[],cursor:'0',more:false,elapsedMs:1}}))
    }
  }
  async terminate() {if (!this.terminated) {this.terminated = true; this.emit('exit',0)} return 0}
}
const executions = new ExecutionStore(directory)
const service = new ConnectionService(() => true,directory,undefined,memoryPasswordProtector,executions,undefined,() => {const worker = new FixtureWorker(); workers.push(worker); return worker})
let staleSnapshot
const server = createServer(async (request,response) => {
  try {
    if (request.url.startsWith('/fixture-release/')) {gates.get(decodeURIComponent(request.url.split('/').at(-1)))?.(); response.end('{}'); return}
    if (request.url.startsWith('/api/database/connections')) {
      if (request.method === 'GET' && staleSnapshot) {response.setHeader('Content-Type','application/json'); response.end(JSON.stringify(staleSnapshot)); staleSnapshot = undefined; return}
      await connectionApi(service,executions,new URL(request.url,'http://127.0.0.1').searchParams.get('conversationId') || 'fixture',request,response); return
    }
    const name = request.url === '/fixture.js' ? 'fixture.js' : 'index.html'
    response.setHeader('Content-Type',name.endsWith('.js') ? 'text/javascript' : 'text/html')
    response.end(await readFile(join(outdir,name)))
  } catch (error) {response.statusCode = 500; response.end(JSON.stringify({error:error.message}))}
})
await new Promise(ok => server.listen(0,'127.0.0.1',ok))
const browser = await chromium.launch({channel:'msedge',headless:true})
const page = await browser.newPage({viewport:{width:1440,height:900}})
page.setDefaultTimeout(7000)
const errors = []; page.on('pageerror',error => errors.push(error.message))
const row = name => page.locator('.db-tree-conn-row').filter({has:page.locator('.db-tree-label',{hasText:new RegExp('^'+name+'$')})})
const add = async name => {
  const button = page.getByRole('button',{name:'新建连接',exact:true})
  if (await button.count()) await button.click(); else await page.getByRole('button',{name:'添加连接',exact:true}).click()
  const dialog = page.getByRole('dialog',{name:'新建数据库连接'})
  await dialog.getByRole('button',{name:'Redis',exact:true}).click()
  await dialog.getByLabel('连接名称 · 可选').fill(name)
  await dialog.getByLabel('主机地址').fill('127.0.0.1')
  await dialog.getByRole('button',{name:'连接',exact:true}).click()
  await dialog.waitFor({state:'hidden'})
  await row(name).waitFor()
}
const release = name => page.evaluate(name => fetch('/fixture-release/'+name),name)
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await add('slow-a')
  assert.equal(service.list('fixture')[0].lifecycle.status,'running')
  await add('fast-b')
  await row('fast-b').locator('.is-live').waitFor()
  await row('fast-b').getByText('fast-b',{exact:true}).click()
  const b = service.list('fixture').find(row => row.name === 'fast-b')
  await page.waitForFunction(id => document.getElementById('active').textContent === id,b.id)
  await page.getByText('没有匹配的 Key。',{exact:true}).waitFor()
  assert.ok(dispatched.some(item => item.name === 'fast-b' && item.action === 'redis-scan'))
  await release('slow-a')
  await row('slow-a').locator('.is-live').waitFor()
  assert.equal(await page.locator('#active').textContent(),b.id,'late A cannot steal selection from B')
  await add('slow-cancel')
  await row('slow-cancel').getByRole('button',{name:'取消连接 slow-cancel',exact:true}).click()
  await row('slow-cancel').locator('.is-off').waitFor()
  await release('slow-cancel')
  assert.equal(service.list('fixture').find(row => row.name === 'slow-cancel').lifecycle.status,'cancelled')
  assert.equal(service.list('fixture').find(row => row.name === 'slow-cancel').live,false)
  assert.equal(await page.locator('#active').textContent(),b.id)
  await page.route('**/api/database/connections?*', async route => {
    const input = route.request().postDataJSON()
    if (input?.action === 'connection-start' && input.input?.name === 'slow-receipt') {await route.fetch(); await route.abort('failed')}
    else await route.continue()
  })
  await add('slow-receipt')
  assert.equal(workers.filter(worker => worker.name === 'slow-receipt').length,1,'lost receipt must be reconciled without another start')
  await page.unroute('**/api/database/connections?*')
  await row('slow-receipt').getByRole('button',{name:'取消连接 slow-receipt',exact:true}).click()
  await row('fast-b').getByRole('button',{name:'更多 fast-b 操作'}).click()
  await page.getByRole('menuitem',{name:'编辑',exact:true}).click()
  const editing = page.getByRole('dialog',{name:'编辑数据库连接'})
  await editing.getByLabel('连接名称 · 可选').fill('slow-update')
  await editing.getByRole('button',{name:'保存并重连',exact:true}).click()
  await editing.waitFor({state:'hidden'})
  await row('fast-b').getByRole('button',{name:'取消连接 fast-b',exact:true}).click()
  await release('slow-update')
  assert.equal(service.list('fixture').find(row => row.id === b.id).generation,b.generation)
  assert.equal(service.list('fixture').find(row => row.id === b.id).live,true)
  await add('failed')
  await row('failed').getByText('连接失败',{exact:true}).waitFor()
  await row('failed').getByRole('button',{name:'更多 failed 操作'}).click()
  await page.getByRole('menuitem',{name:'编辑',exact:true}).click()
  await page.getByRole('dialog',{name:'编辑数据库连接'}).waitFor()
  await page.getByRole('button',{name:'关闭连接窗口'}).click()
  staleSnapshot = {...service.snapshot('fixture'),revision:0,connections:[]}
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await page.waitForTimeout(150)
  assert.equal(await row('fast-b').count(),1,'an old snapshot cannot erase current rows')
  const a = service.list('fixture').find(item => item.name === 'slow-a')
  await row('fast-b').getByText('fast-b',{exact:true}).click()
  service.activate('fixture',b.id); service.activate('other',a.id)
  await page.getByRole('button',{name:'对话 B',exact:true}).click()
  await page.waitForFunction(id => document.getElementById('active').textContent === id,a.id)
  await page.getByRole('button',{name:'对话 A',exact:true}).click()
  await page.waitForFunction(id => document.getElementById('active').textContent === id,b.id)
  assert.equal(service.snapshot('fixture').lastActiveId,b.id)
  assert.equal(service.snapshot('other').lastActiveId,a.id)
  await row('fast-b').getByRole('button',{name:'更多 fast-b 操作'}).click()
  await page.getByRole('menuitem',{name:'断开',exact:true}).click()
  await page.getByRole('button',{name:'断开共享连接',exact:true}).click()
  await row('fast-b').locator('.is-off').waitFor()
  assert.equal(service.list('fixture').find(row => row.id === b.id).desiredState,'offline')
  assert.deepEqual(errors,[])
  await page.screenshot({path:join(outdir,'workbench.png')})
  await writeFile(join(outdir,'acceptance.json'),JSON.stringify({scope:'controlled real workbench + HTTP + Host, simulated database Workers',passed:['background form closes','A and B handshakes overlap','B independently reads','late A preserves B selection','cancel ignores late success','lost receipt reconciled without redispatch','cancelled update preserves login','failed profile editable','stale snapshot rejected','independent disconnect','conversation switching restores independent active connections'],liveDatabase:'NOT_RUN',installedDesktop:'NOT_RUN'},null,2))
  console.log('PASS: 11 controlled connection isolation browser checks')
} finally {
  await page.close(); await browser.close(); await service.dispose(); executions.dispose(); server.closeAllConnections(); await new Promise(ok => server.close(ok)); await rm(directory,{recursive:true,force:true})
}

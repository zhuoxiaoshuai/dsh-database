import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { parseKafkaCommand } from '../src/shared/kafka-command.mjs'

const outdir = resolve('artifacts/kafka-command-builder/ui')
await mkdir(outdir,{recursive:true})
await build({entryPoints:['test/fixtures/kafka-builder-ui.tsx'],bundle:true,format:'esm',outdir,entryNames:'fixture'})
await writeFile(resolve(outdir,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/fixture.css"><style>html,body,#app{height:100%;margin:0}</style></head><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>')
const server=createServer(async(request,response)=>{
  const path=new URL(request.url,'http://localhost').pathname
  const file=resolve(outdir,'.'+(path==='/'?'/index.html':path))
  if(!file.startsWith(outdir+'\\')&&!file.startsWith(outdir+'/')){response.writeHead(404);response.end();return}
  try{const body=await readFile(file);response.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html'});response.end(body)}catch{response.writeHead(404);response.end()}
})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
const browser=await chromium.launch({channel:'msedge',headless:true})
const checks=[],errors=[]
const url=`http://127.0.0.1:${server.address().port}/`
async function create(width=1200,theme='light'){
  const page=await browser.newPage({viewport:{width,height:900},colorScheme:theme})
  page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message))
  await page.goto(url);await page.evaluate(theme=>{document.documentElement.dataset.theme=theme},theme)
  const workspace=page.getByLabel('Kafka 工作区',{exact:true})
  await workspace.getByRole('tab',{name:'查询',exact:true}).click()
  const editor=workspace.getByLabel('Kafka 命令',{exact:true})
  const showEditor=async()=>{const tab=workspace.getByRole('tablist',{name:'编辑与结果'}).getByRole('tab',{name:'编辑',exact:true});if(await tab.isVisible())await tab.click()}
  const fill=async text=>{await showEditor();await editor.fill(text)}
  const run=async()=>{await showEditor();await editor.press('ControlOrMeta+Enter')}
  const builder=async()=>{await workspace.getByRole('button',{name:'生成命令',exact:true}).click();return workspace.getByRole('dialog',{name:'生成 Kafka 命令'})}
  return {page,workspace,editor,showEditor,fill,run,builder}
}
try{
  for(const width of [420,768,1200])for(const theme of ['light','dark']){
    const {page,workspace,editor,fill,builder}=await create(width,theme)
    try{
      await fill('TOPICS')
      const dialog=await builder()
      await dialog.getByLabel('Topic',{exact:true}).fill('orders')
      await dialog.getByLabel('读取起点',{exact:true}).selectOption('offset')
      await dialog.getByLabel('起始 Offset',{exact:true}).fill('9007199254740993')
      assert.match(await dialog.getByLabel('生成命令预览').innerText(),/OFFSET 9007199254740993/)
      await dialog.getByRole('button',{name:'生成',exact:true}).click()
      assert.equal((await editor.innerText()).trimEnd(),'TOPICS\nPEEK "orders" PARTITION 0 FROM OFFSET 9007199254740993 LIMIT 20')
      await editor.focus();await editor.press('ControlOrMeta+z')
      assert.equal(await editor.innerText(),'TOPICS')
      const reopen=await builder()
      assert.equal(await reopen.getByLabel('起始 Offset',{exact:true}).inputValue(),'9007199254740993')
      await reopen.getByLabel('Kafka 命令操作').selectOption('produce-batch')
      await reopen.getByLabel('Topic',{exact:true}).fill('orders')
      await reopen.getByLabel('消息 1 Value',{exact:true}).fill('first\nsecond; {"a":1}')
      await reopen.getByRole('button',{name:'添加消息',exact:true}).click()
      await reopen.getByLabel('消息 2 Value格式',{exact:true}).selectOption('base64')
      await reopen.getByLabel('消息 2 Value',{exact:true}).fill('AP8=')
      assert.match(await reopen.getByLabel('生成命令预览').innerText(),/"base64":"AP8="/)
      await page.screenshot({path:resolve(outdir,`builder-${width}-${theme}.png`)})
      const bounds=await reopen.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1)
      await reopen.getByRole('button',{name:'取消',exact:true}).click()
      assert.equal(await workspace.getByRole('button',{name:'生成命令',exact:true}).evaluate(el=>el===document.activeElement),true)
      assert.equal(await page.evaluate(()=>window.kafkaBuilderFixture.state.runs.length),0)
      checks.push({width,theme,appendUndo:true,binaryCards:true,focusReturn:true})
    }finally{await page.close()}
  }
  {
    const {page,builder}=await create()
    try{
      const dialog=await builder()
      await dialog.getByRole('button',{name:'生成',exact:true}).click()
      await dialog.getByText('Topic 名称无效',{exact:true}).waitFor()
      assert.equal(await dialog.getByLabel('Topic',{exact:true}).evaluate(el=>el===document.activeElement),true)
      for(const kind of ['topics','describe','topic-config','topic-groups','create-topic','peek','time-offsets','scan','produce','produce-batch','tombstone','groups','group','group-topics','group-topic','set-group-offsets']){
        await dialog.getByLabel('Kafka 命令操作').selectOption(kind)
        const group=dialog.getByLabel('消费组',{exact:true}),topic=dialog.getByLabel('Topic',{exact:true})
        if(await group.count())await group.fill('billing')
        if(await topic.count())await topic.fill('orders')
        if(kind==='create-topic')await dialog.getByLabel('测试 Topic 名称').fill('dsh-test-form')
        if(kind==='time-offsets'||kind==='scan'||kind==='set-group-offsets')await dialog.getByLabel('日期时间',{exact:true}).fill('2026-10-16T12:00')
        if(kind==='set-group-offsets')await dialog.getByLabel('分区 1 预期旧 Offset',{exact:true}).fill('9007199254740993')
        if(kind==='tombstone')await dialog.getByLabel('Key',{exact:true}).fill('key')
        const command=await dialog.getByLabel('生成命令预览').innerText()
        assert.equal(parseKafkaCommand(command).kind,kind)
      }
      await dialog.getByLabel('Kafka 命令操作').selectOption('produce')
      await dialog.locator('summary').filter({hasText:'高级参数'}).click()
      await dialog.getByRole('checkbox',{name:'提供 Headers',exact:true}).check()
      await dialog.getByRole('button',{name:'添加 Header 值'}).click()
      await dialog.getByLabel('Header 1 名称',{exact:true}).fill('trace')
      await dialog.getByLabel('Header 1 值',{exact:true}).fill('one')
      await dialog.getByRole('button',{name:'添加 Header 值'}).click()
      await dialog.getByLabel('Header 2 名称',{exact:true}).fill('trace')
      await dialog.getByLabel('Header 2 值',{exact:true}).fill('two')
      assert.deepEqual(parseKafkaCommand(await dialog.getByLabel('生成命令预览').innerText()).headers.trace,['one','two'])
      await dialog.getByRole('button',{name:'取消',exact:true}).click()
      checks.push({allOperationForms:16,fieldErrors:true,firstInvalidFocus:true,repeatedHeaders:true})
    }finally{await page.close()}
  }
  {
    const {page,workspace,editor,fill,run,builder}=await create()
    try{
      await fill('TOPICS\nGROUPS')
      await editor.press('Home');await editor.press('ControlOrMeta+Home');await editor.press('Shift+End')
      await workspace.getByRole('button',{name:'执行选中',exact:true}).first().click()
      await workspace.getByText('1/1 成功',{exact:true}).waitFor()
      assert.deepEqual(await page.evaluate(()=>window.kafkaBuilderFixture.state.runs.map(item=>item.text)),['TOPICS'])
      await fill('TOPICS\nGROUPS');await run()
      await workspace.getByText('2/2 成功',{exact:true}).waitFor()
      await workspace.getByRole('tab',{name:'结果 2 · GROUPS · 成功',exact:true}).click()
      await workspace.getByText('billing',{exact:true}).first().waitFor()
      await page.screenshot({path:resolve(outdir,'multiple-results.png')})
      await fill('PEEK "orders" PARTITION 0 FROM BEGINNING LIMIT 1\nPEEK "other" PARTITION 0 FROM BEGINNING LIMIT 1');await run()
      await workspace.getByText('2/2 成功',{exact:true}).waitFor()
      await workspace.getByText('编辑并重新发布',{exact:true}).click()
      await workspace.getByLabel('目标 Topic',{exact:true}).fill('modified-first')
      await workspace.getByRole('tab',{name:'结果 2 · PEEK · 成功',exact:true}).click()
      await workspace.getByText('编辑并重新发布',{exact:true}).click()
      assert.equal(await workspace.getByLabel('目标 Topic',{exact:true}).inputValue(),'other','message replay drafts must not leak between result tabs with the same offset')
      await page.evaluate(()=>window.kafkaBuilderFixture.resetRuns())
      await fill('PRODUCE {\n"topic":"orders",\n"value":"hello; world"\n}\nPRODUCE {"topic":"other","value":"next"}\nTOPICS')
      await run()
      const confirm=workspace.getByRole('dialog',{name:'确认 Kafka 写操作'})
      await confirm.waitFor();assert.match(await confirm.innerText(),/orders/);assert.match(await confirm.innerText(),/other/)
      assert.equal(await page.evaluate(()=>window.kafkaBuilderFixture.state.runs.length),0)
      await confirm.getByRole('button',{name:'执行 Kafka 写操作',exact:true}).click()
      await workspace.getByText('3/3 成功',{exact:true}).waitFor()
      assert.equal(await page.evaluate(()=>window.kafkaBuilderFixture.state.runs.length),3)
      assert.equal(await workspace.getByRole('dialog').count(),0)
      await page.evaluate(()=>window.kafkaBuilderFixture.resetRuns())
      await fill('PRODUCE {"topic":"orders","value":"cancel"}\nTOPICS');await run()
      await workspace.getByRole('dialog',{name:'确认 Kafka 写操作'}).getByRole('button',{name:'取消',exact:true}).click()
      assert.equal(await page.evaluate(()=>window.kafkaBuilderFixture.state.runs.length),0)
      await fill('TOPICS\nPRODUCE {')
      await run();await workspace.getByText(/命令不完整/).first().waitFor()
      assert.equal(await page.evaluate(()=>window.kafkaBuilderFixture.state.runs.length),0)
      await page.evaluate(()=>{window.kafkaBuilderFixture.state.failure='topics:failed'})
      await fill('TOPICS\nGROUPS');await run()
      await workspace.getByRole('tab',{name:'结果 2 · GROUPS · 未执行',exact:true}).waitFor()
      assert.equal(await page.evaluate(()=>window.kafkaBuilderFixture.state.runs.length),1)
      await page.evaluate(()=>{window.kafkaBuilderFixture.resetRuns();window.kafkaBuilderFixture.state.hold='produce'})
      await fill('PRODUCE {"topic":"orders","value":"a"}\nGROUPS');await run()
      await workspace.getByRole('dialog',{name:'确认 Kafka 写操作'}).getByRole('button',{name:'执行 Kafka 写操作'}).click()
      await page.waitForFunction(()=>window.kafkaBuilderFixture.state.runs.length===1)
      await workspace.getByRole('button',{name:'停止',exact:true}).first().click()
      await workspace.getByRole('tab',{name:'结果 1 · PRODUCE · 结果未知',exact:true}).waitFor()
      await workspace.getByRole('tab',{name:'结果 2 · GROUPS · 未执行',exact:true}).waitFor()
      assert.equal(await page.evaluate(()=>window.kafkaBuilderFixture.state.runs.length),1)
      const dialog=await builder()
      await dialog.getByLabel('Kafka 命令操作').selectOption('set-group-offsets')
      await dialog.getByLabel('消费组',{exact:true}).fill('billing');await dialog.getByLabel('Topic',{exact:true}).fill('orders')
      await dialog.getByRole('button',{name:'读取当前位点'}).click()
      await page.waitForFunction(()=>document.querySelector('[aria-label="分区 1 预期旧 Offset"]')?.value==='9007199254740993')
      await dialog.getByRole('button',{name:'添加分区'}).click();await dialog.getByRole('button',{name:'读取当前位点'}).click()
      await dialog.getByRole('checkbox',{name:'预期当前尚未提交'}).nth(1).check()
      assert.equal(await dialog.getByRole('checkbox',{name:'预期当前尚未提交'}).nth(1).isChecked(),true)
      await dialog.getByLabel('日期时间',{exact:true}).fill('2026-10-16T12:00')
      assert.match(await dialog.getByLabel('生成命令预览').innerText(),/"1":null/)
      await dialog.getByRole('button',{name:'取消',exact:true}).click()
      checks.push({selection:true,sequentialResults:true,isolatedResultDrafts:true,singleWriteConfirmation:true,preflight:true,stopUnknown:true,offsetReadback:true})
    }finally{await page.close()}
  }
  {
    const {page,workspace,editor,fill,run}=await create()
    try{
      await fill('TOPICS\nGROUPS')
      await editor.press('ControlOrMeta+Home')
      for(let i=0;i<4;i++)await editor.press('Shift+ArrowRight')
      await workspace.getByRole('button',{name:'执行选中',exact:true}).first().click()
      await workspace.getByText(/不支持此 Kafka 命令/).first().waitFor()
      assert.equal(await page.evaluate(()=>window.kafkaBuilderFixture.state.runs.length),0)
      await page.evaluate(()=>{window.kafkaBuilderFixture.state.hold='topics';window.kafkaBuilderFixture.state.ignoreAbort=true})
      await fill('TOPICS\nGROUPS');await run()
      await page.waitForFunction(()=>window.kafkaBuilderFixture.state.runs.length===1)
      await page.evaluate(()=>window.kafkaBuilderFixture.reconnect())
      await workspace.getByRole('tab',{name:'查询',exact:true}).click()
      await page.evaluate(()=>window.kafkaBuilderFixture.state.releaseRun())
      await page.waitForTimeout(100)
      assert.equal((await editor.innerText()).trim(),'')
      assert.equal(await page.evaluate(()=>window.kafkaBuilderFixture.state.runs.length),1)
      assert.equal(await workspace.getByRole('tab',{name:/结果 1/}).count(),0)
      checks.push({partialSelectionRejected:true,lateRunIsolated:true,noNextDispatchAfterReconnect:true})
    }finally{await page.close()}
  }
  {
    const {page,workspace,builder}=await create()
    try{
      const before=await page.evaluate(()=>window.kafkaBuilderFixture.state.reads.length)
      const dialog=await builder()
      await dialog.getByLabel('Kafka 命令操作').selectOption('groups')
      await page.waitForTimeout(300)
      assert.equal(await page.evaluate(()=>window.kafkaBuilderFixture.state.reads.length),before,'hidden fields must not fetch')
      await dialog.getByLabel('Kafka 命令操作').selectOption('describe')
      await dialog.getByLabel('Topic',{exact:true}).focus()
      await page.getByRole('option',{name:'orders',exact:true}).waitFor()
      await page.getByRole('button',{name:'加载更多候选',exact:true}).click()
      await page.getByRole('option',{name:'page-two',exact:true}).click()
      assert.match(await dialog.getByLabel('生成命令预览').innerText(),/page-two/)
      await page.evaluate(()=>{window.kafkaBuilderFixture.state.failCandidates=true})
      await dialog.getByLabel('Topic',{exact:true}).fill('manual-topic')
      await page.getByRole('status').filter({hasText:'模拟候选读取失败，可手工输入。'}).waitFor()
      assert.match(await dialog.getByLabel('生成命令预览').innerText(),/manual-topic/)
      await page.evaluate(()=>{window.kafkaBuilderFixture.state.failCandidates=false})
      await page.getByRole('button',{name:'重试加载',exact:true}).click()
      await page.getByRole('status').filter({hasText:'模拟候选读取失败，可手工输入。'}).waitFor({state:'hidden'})
      await dialog.getByRole('button',{name:'取消',exact:true}).click()
      await page.evaluate(()=>{window.kafkaBuilderFixture.state.delayCandidates=true})
      const next=await builder();await next.getByLabel('Kafka 命令操作').selectOption('group');await next.getByLabel('消费组',{exact:true}).focus()
      await page.waitForFunction(()=>!!window.kafkaBuilderFixture.state.releaseCandidates)
      await next.getByRole('button',{name:'取消',exact:true}).click()
      await page.evaluate(()=>window.kafkaBuilderFixture.state.releaseCandidates())
      const again=await builder();await again.getByLabel('消费组',{exact:true}).focus()
      assert.equal(await page.getByRole('option',{name:'STALE_CANDIDATE',exact:true}).count(),0)
      await again.getByRole('button',{name:'取消',exact:true}).click()
      await page.evaluate(()=>window.kafkaBuilderFixture.reconnect())
      await workspace.getByRole('tab',{name:'查询',exact:true}).click()
      const fresh=await builder();assert.equal(await fresh.getByLabel('Kafka 命令操作').inputValue(),'peek')
      await fresh.getByRole('button',{name:'取消',exact:true}).click()
      await page.evaluate(()=>window.kafkaBuilderFixture.setEnvironment('uat'))
      const uat=await builder()
      assert.equal(await uat.locator('option[value="produce"]').isDisabled(),true)
      await uat.getByRole('button',{name:'取消',exact:true}).click()
      checks.push({onDemand:true,paging:true,manualInput:true,retry:true,staleCandidates:true,generationReset:true,uat:true})
    }finally{await page.close()}
  }
  assert.deepEqual(errors,[])
  await writeFile(resolve(outdir,'report.json'),JSON.stringify({status:'PASS',checks,errors},null,2))
  console.log(JSON.stringify({status:'PASS',cases:checks.length,output:outdir}))
}catch(error){await writeFile(resolve(outdir,'report.json'),JSON.stringify({status:'FAIL',checks,errors,error:String(error),stack:error.stack},null,2));throw error}
finally{await browser.close();await new Promise(done=>server.close(done))}

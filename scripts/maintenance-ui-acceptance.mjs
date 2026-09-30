import { build } from 'esbuild'
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const directory = resolve('artifacts/maintenance-ui')
await mkdir(directory, { recursive: true })
const fixture = `
import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
import {ObjectWorkspace} from './src/client/object-workspace.tsx';
import {StructureForm} from './src/client/structure-form.tsx';
const connection={id:'fixture',name:'Explicit UI fixture',generation:'fixture',dialect:'mysql',environment:'sit',database:'business',version:'fixture',live:true};
let enabled=false; window.requests=[];
const metadata={columns:[{name:'id',type:'bigint',key:'PRI'},{name:'note',type:'varchar(80)'}],indexes:{status:'actual',values:[]},constraints:{status:'actual',values:[]},definition:{status:'actual',values:[{ddl:'CREATE TABLE fixture (id BIGINT PRIMARY KEY)'}]}};
const rows={columns:['id','note'],rows:[['1','original']],elapsedMs:1,truncated:false};
const capability={id:'cap',source:'table',schema:'business',table:'records',canEnable:true,canInsert:true,canUpdate:true,canDelete:true,reason:'',primaryKeys:['id'],resultPrimaryKeys:['id'],identityColumns:[],columns:[{resultColumn:'id',sourceColumn:'id',editable:false},{resultColumn:'note',sourceColumn:'note',editable:true}]};
const bridge={mode:'preview',connections:[connection],tables:()=>[],execute:async()=>rows,
catalog:async(_,input)=>{await new Promise(r=>setTimeout(r,80));return {collectedAt:new Date().toISOString(),source:'Explicit UI fixture',...(input.kind==='schemas'?{items:[{name:'business'}]}:input.kind==='tables'?{items:[{name:'records'}]}:input.kind==='table'?metadata:{summary:{objects:1}})}},
browse:async()=>({...rows,generatedSql:'SELECT id,note FROM records',warning:'Explicit UI fixture'}),
maintenance:async(_,input)=>{window.requests.push(input);if(input.kind==='capability')return capability;if(input.kind==='enable')return{enabled:enabled=input.enabled};if(input.kind==='reject')return{};if(!enabled)throw Error('Fixture requires manual enable');if(input.kind==='ddl-preview')return{id:'ddl',steps:[{kind:'createTable',sql:'CREATE TABLE fixture (id BIGINT)',state:'not-run'}],destructive:true,before:metadata};if(input.kind==='preview'){const values=input.operation?.values||{};return{id:'dml',sql:'UPDATE fixture SET note=? WHERE id=?',params:[values.note,input.operation?.original?.id],expectedRows:1};}return{status:'success',message:'Explicit fixture success',steps:[{kind:'createTable',sql:'CREATE TABLE fixture (id BIGINT)',state:'success'}]};}};
function Fixture(){
  const [structure,setStructure]=useState(false),[sub,setSub]=useState('data');
  return <div className="db-workbench" style={{height:'100vh',display:'flex',flexDirection:'column'}}><div className="db-catalog-tools"><button onClick={()=>setStructure(true)}>新建表</button></div>
    <ObjectWorkspace bridge={bridge} connection={connection} schema="business" table="records" isView={false} sub={sub} onSub={setSub} onStatus={()=>{}}/>
    {structure&&<StructureForm bridge={bridge} connection={connection} schema="business" metadata={metadata} onClose={()=>setStructure(false)} onChanged={()=>{}}/>}
  </div>
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`
await build({ stdin: { contents: fixture, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: `${directory}/fixture.js`, platform: 'browser', format: 'iife' })
const js = await readFile(`${directory}/fixture.js`), css = await readFile('src/client/style.css', 'utf8')
const server = createServer((req, res) => { if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(js) } else { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(`<html><head><style>body{margin:0}#root{height:100vh}${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`) } })
await new Promise(r => server.listen(0, '127.0.0.1', r))
let browser, page
const report = { status: 'RUNNING', scope: 'Explicit component fixture; no database or installed-host claims', checks: [] }
try {
  browser = await chromium.launch({ executablePath: process.env.DSH_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('cell', { name: 'original', exact: true }).waitFor()
  await page.getByRole('button', { name: '开启维护', exact: true }).click()
  await page.getByRole('button', { name: '关闭维护', exact: true }).waitFor()
  await page.getByRole('cell', { name: 'original', exact: true }).dblclick()
  const input = page.getByLabel('编辑 note', { exact: true })
  await input.fill('edited'); await input.press('End'); await input.press('!')
  assert.equal(await input.inputValue(), 'edited!', 'Grid editor must retain typing focus')
  await input.press('Enter')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: '确认提交', exact: true })
  await confirm.getByRole('button', { name: '确认', exact: true }).click()
  await confirm.waitFor({ state: 'hidden' })
  const dmlPreview = await page.evaluate(() => window.requests.find(r => r.kind === 'preview'))
  assert.equal(dmlPreview.operation.values.note, 'edited!', 'Grid save must carry the edited cell value')
  await page.getByRole('cell', { name: 'original', exact: true }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  const remove = page.getByRole('dialog', { name: '确认提交', exact: true })
  await remove.waitFor()
  assert.equal(await page.getByRole('dialog', { name: '确认删除' }).count(), 0)
  await remove.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: 'CSV', exact: true }).waitFor()
  await page.getByRole('button', { name: 'JSON', exact: true }).waitFor()
  await page.getByRole('button', { name: '撤销修改', exact: true }).waitFor()
  report.checks.push('Object workspace enables maintenance; grid edit retains focus and completes one real preview/confirmation')
  await page.getByRole('button', { name: '新建表', exact: true }).click()
  const structure = page.getByRole('dialog', { name: '表结构维护', exact: true })
  await structure.getByRole('button', { name: '开启 SIT 维护', exact: true }).click()
  await structure.getByLabel('新表名称', { exact: true }).fill('fixture')
  for (const dark of [false, true]) {
    await page.evaluate(dark => {
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
      if (dark) document.body.setAttribute('data-ds-dark-theme', '')
      else document.body.removeAttribute('data-ds-dark-theme')
    }, dark)
    for (const width of [420, 768, 1200]) {
      await page.setViewportSize({ width, height: 900 })
      const box = await structure.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width)
      await page.screenshot({ path: `${directory}/structure-${dark ? 'dark' : 'light'}-${width}.png` })
    }
  }
  await structure.getByRole('button', { name: '预览结构变更', exact: true }).click()
  assert.equal(await structure.getByRole('button', { name: '确认并执行结构变更', exact: true }).isEnabled(), false)
  await structure.getByLabel('确认目标表名', { exact: true }).fill('fixture')
  await structure.getByRole('button', { name: '确认并执行结构变更', exact: true }).click()
  await structure.getByRole('button', { name: '关闭并核对结构', exact: true }).click()
  report.checks.push('Structure form fits light/dark 420/768/1200 widths and requires target name in the same confirmation')
  assert.deepEqual(errors, [])
  assert.equal(await page.evaluate(() => window.requests.filter(r => r.kind === 'execute').length), 2)
  report.status = 'PASS'
} catch (error) { report.status = 'FAIL'; report.error = error.message; process.exitCode = 1; await page?.screenshot({ path: `${directory}/failure.png` }).catch(() => {}) }
finally { await browser?.close(); await new Promise(r => server.close(r)); await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)) }

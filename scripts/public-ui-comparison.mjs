import {createServer} from 'node:http'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {chromium} from 'playwright'

// Replay saved bundles: the before bundle must never be rebuilt from current source.
const out=resolve('artifacts/ui/public-components')
const bundles={before:resolve(out,'before'),after:resolve('artifacts/ui/plugin-unification/after')}
const server=createServer(async(req,res)=>{
  const [stage,file]=new URL(req.url,'http://fixture').pathname.slice(1).split('/')
  if(!bundles[stage]){res.writeHead(404).end();return}
  if(file==='fixture.js'||file==='fixture.css'){
    res.setHeader('content-type',file.endsWith('.js')?'application/javascript':'text/css')
    res.end(await readFile(resolve(bundles[stage],file)));return
  }
  res.setHeader('content-type','text/html')
  res.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/${stage}/fixture.css"><style>html,body,#app{height:100%;margin:0}</style></head><body><div id="app"></div><script type="module" src="/${stage}/fixture.js"></script></body></html>`)
})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
const browser=await chromium.launch({channel:'msedge',headless:true})
try{
  for(const stage of ['before','after']){
    const dir=resolve(out,'comparison',stage);await mkdir(dir,{recursive:true})
    const page=await browser.newPage({viewport:{width:1200,height:850}})
    await page.goto(`http://127.0.0.1:${server.address().port}/${stage}/`)
    await page.waitForFunction(()=>!!window.fixture)
    for(const width of [420,768,1200])for(const mode of ['light','dark']){
      await page.evaluate(({width,mode})=>{
        window.fixture.setLayout('shell');window.fixture.setSource('kafka');window.fixture.setForm(false)
        window.fixture.setTheme({paletteId:'mist-green',mode})
        document.querySelector('[data-instance=main]').style.width=width+'px'
      },{width,mode})
      await page.waitForTimeout(150)
      await page.locator('[data-instance=main]').screenshot({path:resolve(dir,`shell-${width}-${mode}.png`),animations:'disabled'})
      await page.evaluate(()=>window.fixture.setForm(true));await page.getByRole('dialog',{name:'新建数据库连接'}).waitFor()
      // Remove transient focus hints only for a stable visual comparison.
      await page.evaluate(()=>document.activeElement?.blur());await page.waitForTimeout(100)
      await page.locator('[data-instance=main]').screenshot({path:resolve(dir,`connection-${width}-${mode}.png`),animations:'disabled'})
    }
    await page.close()
  }
  const rows=['# 公共 UI 同尺寸对照','','使用实施前保存的编译夹具与实施后夹具，视口固定 1200 × 850，仅改变插件宽度。真实服务及已安装 Desktop：`NOT_RUN`。','','| 页面 / 宽度 / 模式 | 实施前 | 实施后 |','|---|---|---|']
  for(const page of ['shell','connection'])for(const width of [420,768,1200])for(const mode of ['light','dark']){
    const name=`${page}-${width}-${mode}.png`
    rows.push(`| ${page} / ${width} / ${mode} | ![前](comparison/before/${name}) | ![后](comparison/after/${name}) |`)
  }
  await writeFile(resolve(out,'comparison.md'),rows.join('\n')+'\n')
  console.log('PASS: 12 pairs captured from saved before/after bundles')
}finally{await browser.close();await new Promise(done=>server.close(done))}

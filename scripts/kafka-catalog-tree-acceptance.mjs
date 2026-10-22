import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const outdir = resolve('artifacts/ui/kafka-catalog-tree')
await mkdir(outdir, { recursive: true })
await build({
  stdin: { resolveDir: resolve('.'), sourcefile: 'kafka-catalog-tree-fixture.tsx', loader: 'tsx', contents: `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { WorkbenchShell } from './src/client/workspace/shell/workbench-shell.tsx'
    import './src/client/style.css'

    const kafka = {
      id: 'kafka-fixture', generation: 'g1', name: 'Kafka · 127.0.0.1', dialect: 'kafka',
      environment: 'sit', database: '', live: true, health: 'ready',
    }
    const redis = {
      id: 'redis-fixture', generation: 'g1', name: 'Redis · local', dialect: 'redis',
      environment: 'sit', database: '0', databases: ['0', '1', '2'], version: '7', live: true, health: 'ready',
    }
    const mysql = {
      id: 'mysql-fixture', generation: 'g1', name: 'MySQL · local', dialect: 'mysql',
      environment: 'sit', database: 'app', version: '8', live: true, health: 'ready',
    }
    const aiDocument = { sourceId: 'kafka', text: '', context: {}, revision: 1, controller: 'ai' }
    const probe = { failDetails: false, calls: [] }
    window.kafkaTreeFixture = probe
    const bridge = {
      mode: 'host', connections: [kafka], tables: () => [],
      execute: async () => { throw new Error('unused') },
      executeText: async () => ({kind:'peek',topic:'orders',partition:0,start:'0',low:'0',high:'1',complete:true,messages:[{offset:'0',timestamp:'1',key:{kind:'text',text:'order-1',length:7},value:{kind:'text',text:'inspection-message',length:18},headers:{trace:{kind:'text',text:'trace-1',length:7}}}]}),
      catalog: async (item, input) => {
        if (item?.dialect === 'mysql' && input?.kind === 'schemas') return { items: [{ name: 'app' }, { name: 'hr' }], more: false, collectedAt: '', source: 'test' }
        return { items: [], more: false, collectedAt: '', source: 'test' }
      },
      explorer: async (_connection, action, input) => {
        probe.calls.push({action,input})
        if (action === 'list') {
          if (input.parent === 'folder:groups') {
            return { sourceId: 'kafka', nodes: [{ ref: 'group:billing', title: 'billing', kind: 'group', hasChildren: true }], complete: true }
          }
          return { sourceId: 'kafka', nodes: [
            { ref: 'topic:app-logs', title: 'app-logs', kind: 'topic', hasChildren: false, metadata:{partitionCount:1,replicationFactor:'2',health:'正常'} },
            { ref: 'topic:orders', title: 'orders', kind: 'topic', hasChildren: false, metadata:{partitionCount:2,replicationFactor:'2',health:'异常'} },
          ], complete: true }
        }
        if (action === 'read') {
          if (probe.failDetails && input.refresh && String(input.ref).startsWith('gtopic:')) throw new Error('FIXTURE_REFRESH_DENIED')
          if (String(input.ref).startsWith('topic-groups:')) return {kind:'topic-groups',topic:'orders',associations:[{groupId:'billing',assigned:true,committed:true,complete:true}],complete:true,failed:0,scanned:1,collectedAt:new Date().toISOString()}
          if (String(input.ref).startsWith('group-summary:')) return {kind:'group-summary',groupId:'billing',topics:[{topic:'orders',assignedPartitions:2,totalLag:'4',knownLag:'4',knownPartitions:2,partitionCount:2,complete:true,abnormalPartitions:1,uncommittedPartitions:0}],topicCount:1,totalLag:'4',knownLag:'4',knownPartitions:2,partitionCount:2,complete:true,abnormalPartitions:1,uncommittedPartitions:0,collectedAt:new Date().toISOString()}
          if (String(input.ref).startsWith('gtopic:')) return {kind:'group-topic',groupId:'billing',topic:'orders',state:'Stable',collectedAt:new Date().toISOString(),partitions:[{partition:0,earliest:'0',current:'8',end:'12',lag:'4',status:'normal',consumer:'billing-worker',consumerId:'billing-member-1',clientId:'billing-worker',host:'/10.10.1.11'},{partition:1,earliest:'8',current:'8',end:'8',lag:'0',status:'normal',consumer:'billing-worker',consumerId:'billing-member-2',clientId:'billing-worker',host:'/10.20.1.12'}]}
          if (String(input.ref).startsWith('group:')) return { kind: 'group', groupId: 'billing', state: 'Stable', protocol: 'roundrobin', protocolType: 'consumer', members: [{memberId:'billing-member-1',clientId:'billing-worker',clientHost:'/127.0.0.1',assignment:{orders:[0,1]}}], topics: ['orders'] }
          return { kind: 'topic', topic: 'orders', collectedAt:new Date().toISOString(), partitions: [
            { partition: 0, leader: 1, replicas: [1, 2], isr:[1,2], health:'正常', low: '0', high: '12' },
            { partition: 1, leader: -1, replicas: [1, 2], isr:[], health:'无 Leader', low: '8', high: '8' },
          ] }
        }
        throw new Error('unexpected explorer action')
      },
      executions: async (action) => {
        if (action === 'execution-wait') { await new Promise(resolve => setTimeout(resolve, 500)); return { revision: 0, items: [], events: [] } }
        if (action === 'execution-document-get') return { document: aiDocument }
        return { items: [] }
      },
    }
    function Fixture() {
      const [rows, setRows] = useState([kafka, redis, mysql])
      const [id, setId] = useState(kafka.id)
      const active = rows.find(item => item.id === id) || rows[0]
      return <div className="db-workbench"><WorkbenchShell
        bridge={bridge} conversationId="fixture" connection={active} connections={rows}
        onPick={setId} onAdd={() => {}} onEdit={() => {}}
        onWorkbench={(target, patch) => setRows(current => current.map(item => item.id === target ? { ...item, workbench: { ...item.workbench, ...patch } } : item))}
      /></div>
    }
    createRoot(document.getElementById('app')).render(<Fixture />)
  ` },
  bundle: true, format: 'esm', outdir, entryNames: 'fixture', assetNames: 'fixture',
})
await writeFile(resolve(outdir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/fixture.css"><style>html,body,#app,.db-workbench,.db-shell{height:100%;margin:0}</style></head><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>')
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname === '/' ? '/index.html' : new URL(request.url, 'http://localhost').pathname
  try {
    const body = await readFile(resolve(outdir, `.${path}`))
    response.writeHead(200, { 'Content-Type': path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : 'text/html' })
    response.end(body)
  } catch { response.writeHead(404); response.end() }
})
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  if (errors.length) throw new Error(errors.join('\n'))
  await page.getByLabel('Kafka 工作区', { exact: true }).waitFor()
  const sidebar = page.getByLabel('我的连接')
  await sidebar.getByText('Topics', { exact: true }).waitFor()
  await sidebar.getByText('消费组', { exact: true }).waitFor()
  assert.equal(await page.locator('.db-search-tree-head > span:visible').innerText(), 'Topics')
  assert.equal(await page.locator('.db-search-tree-modes').count(), 0)
  await page.getByRole('button', { name: 'orders' }).waitFor()
  await page.getByRole('button', { name: 'orders' }).click()
  await page.getByRole('columnheader', { name: '副本', exact: true }).waitFor()
  await page.getByText('副本因子 2').waitFor()
  // End 列空分区以「空」pill 呈现
  await page.getByRole('cell', { name: '空', exact: true }).waitFor()
  await page.getByRole('cell', { name: '无', exact: true }).waitFor()
  await page.screenshot({path:resolve(outdir,'topic.png')})
  assert.equal(await page.evaluate(()=>window.kafkaTreeFixture.calls.some(call=>String(call.input.ref).startsWith('topic-groups:'))),false)
  await page.getByRole('button',{name:'消息',exact:true}).click()
  await page.getByRole('button',{name:'读取消息',exact:true}).click()
  await page.locator('code').getByText('inspection-message',{exact:true}).waitFor()
  await page.getByText('Headers',{exact:true}).click()
  await page.locator('code').getByText('trace-1',{exact:true}).waitFor()
  await page.getByRole('button',{name:'关联消费组',exact:true}).click()
  await page.screenshot({path:resolve(outdir,'topic-groups.png')})
  await page.getByRole('button',{name:'billing',exact:true}).click()
  await page.getByRole('cell',{name:'/10.10.1.11',exact:true}).waitFor()
  await page.getByRole('cell',{name:'/10.20.1.12',exact:true}).waitFor()
  await page.screenshot({path:resolve(outdir,'partition-consumption.png')})
  await page.evaluate(()=>window.kafkaTreeFixture.failDetails=true)
  await page.getByRole('button',{name:'刷新当前详情',exact:true}).click()
  await page.getByText('FIXTURE_REFRESH_DENIED',{exact:true}).waitFor()
  await page.getByRole('cell',{name:'/10.10.1.11',exact:true}).waitFor()
  await page.evaluate(()=>window.kafkaTreeFixture.failDetails=false)
  await page.getByRole('button',{name:'刷新当前详情',exact:true}).click()
  await page.getByText('FIXTURE_REFRESH_DENIED',{exact:true}).waitFor({state:'detached'})
  // 组内 Topic 详情面包屑：组名可点击返回组详情（替代原「分区消费」页签入口）
  await page.getByRole('button',{name:'返回消费组 billing',exact:true}).click()
  await page.getByRole('columnheader',{name:'已分配分区',exact:true}).waitFor()
  await page.getByRole('button',{name:'orders',exact:true}).click()
  await page.getByRole('cell',{name:'/10.10.1.11',exact:true}).waitFor()
  await page.getByRole('button',{name:'返回来源 Topic',exact:true}).click()
  assert.equal(await page.getByRole('button',{name:'关联消费组',exact:true}).getAttribute('aria-pressed'),'true')
  await page.getByRole('button',{name:'分区',exact:true}).click()
  await page.locator('.db-workbench').evaluate(el=>el.classList.add('db-dark'))
  await page.screenshot({path:resolve(outdir,'topic-dark.png')})
  await page.locator('.db-workbench').evaluate(el=>el.classList.remove('db-dark'))
  await sidebar.locator('.db-schema-node').filter({ hasText: '消费组' }).click()
  await page.locator('.db-search-tree-head > span', { hasText: '消费组' }).waitFor()
  await page.locator('.db-search-tree-body').getByText('billing', { exact: true }).waitFor()
  await page.getByRole('button',{name:'billing',exact:true}).click()
  await page.getByRole('button',{name:'orders',exact:true}).waitFor()
  await page.getByRole('columnheader',{name:'已分配分区',exact:true}).waitFor()
  await page.getByRole('button',{name:'加载本页消费汇总',exact:true}).click()
  // 汇总加载后左侧仅显示积压警示 chip（fixture 中 billing totalLag='4'）
  await page.locator('.db-kafka-lag-chip',{hasText:'Lag 4'}).waitFor()
  await page.getByRole('button',{name:'成员',exact:true}).click()
  await page.getByRole('cell',{name:'billing-worker',exact:true}).waitFor()
  await page.screenshot({path:resolve(outdir,'group.png')})
  assert.equal(await page.getByRole('button', { name: 'orders' }).filter({visible:true}).count(), 0)
  assert.equal(await page.locator('.db-search-tree-head button[aria-pressed]').count(), 0)
  const showOnly = async (connectionName, menuLabel, keepLabels) => {
    await page.getByRole('button', { name: `更多 ${connectionName} 操作`, exact: true }).click()
    await page.getByRole('menuitem', { name: menuLabel, exact: true }).click()
    await page.getByRole('button', { name: '清空', exact: true }).click()
    for (const label of keepLabels) await page.getByRole('checkbox', { name: label, exact: true }).check()
    await page.getByRole('button', { name: '保存', exact: true }).click()
  }
  await showOnly('Kafka · 127.0.0.1', '显示的分类', ['消费组'])
  await sidebar.getByText('Topics', { exact: true }).waitFor({ state: 'detached' })
  await sidebar.getByText('消费组', { exact: true }).waitFor()
  await page.getByRole('button', { name: '更多 Kafka · 127.0.0.1 操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '显示的分类', exact: true }).click()
  await page.getByRole('button', { name: '清空', exact: true }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await sidebar.getByText('Topics', { exact: true }).waitFor()
  await sidebar.locator('.db-schema-node').filter({ hasText: 'db1' }).click()
  await showOnly('Redis · local', '显示的数据库', ['db1', 'db2'])
  await sidebar.getByText('db0', { exact: true }).waitFor({ state: 'detached' })
  await sidebar.getByText('db1', { exact: true }).waitFor()
  await sidebar.getByText('db2', { exact: true }).waitFor()
  await sidebar.getByText('app', { exact: true }).waitFor()
  await sidebar.getByText('hr', { exact: true }).waitFor()
  await sidebar.locator('.db-schema-node').filter({ hasText: 'app' }).click()
  await showOnly('MySQL · local', '显示的数据库', ['app'])
  await sidebar.getByText('hr', { exact: true }).waitFor({ state: 'detached' })
  await sidebar.getByText('app', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'PASS', checks: ['left catalog roots', 'topics list', 'describe table', 'groups from left tree', 'no right switcher', 'kafka child filter', 'redis child filter', 'mysql child filter','on-demand associations','direct message reading','association jump and return','partition Hosts','failed refresh retains detail','group summaries'], pageErrors: errors }))
} finally { await page.close(); await browser.close(); await new Promise(resolve => server.close(resolve)) }

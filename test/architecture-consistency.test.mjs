import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { temporaryDirectory as makeTemporaryDirectory, connectionInput } from './helpers.mjs'
import { NacosPreviewConsumption } from '../src/host/nacos-preview-consumption.ts'
import { NacosService } from '../src/host/nacos-service.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { ConnectionService } from '../src/host/connection-service.ts'
import { SqlTemplateStore } from '../src/host/sql-template-store.ts'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
const resources = new Map()
function temporaryDirectory(t, prefix) {
  const { directory, cleanup } = makeTemporaryDirectory(prefix)
  const owned = []; resources.set(directory, owned)
  t.after(async () => { try { for (const resource of owned.reverse()) await resource.dispose() } finally { resources.delete(directory); cleanup() } })
  return directory
}
function disposeAfter(root, resource) { resources.get(root).push(resource) }


test('consumption capacity fails closed and recovers only after expiry', () => {
  let now = 100
  const guard = new NacosPreviewConsumption(1, () => now)
  guard.consume('a', 200)
  assert.throws(() => guard.consume('a', 200), /已执行/)
  assert.throws(() => guard.consume('b', 200), /上限/)
  now = 200
  guard.consume('b', 300)
  assert.throws(() => guard.consume('a', 200), /过期/)
})

test('unknown Nacos write cannot replay after ledger eviction or concurrent submission', async t => {
  const root = temporaryDirectory(t, 'architecture-nacos-')
  const executions = new ExecutionStore(root)
  disposeAfter(root, executions)
  const service = new NacosService(executions)
  const connection = { id: 'c', generation: 'g', name: 'Nacos', dialect: 'nacos', environment: 'sit' }
  const input = { namespaceId: '', group: 'G', dataId: 'a', kind: 'update', expectedMd5: 'm', type: 'text', content: 'next' }
  let writes = 0
  const send = async (action, _input, _signal, dispatched) => {
    if (action === 'nacos-config') return { content: 'old', md5: 'm', type: 'text' }
    dispatched(); writes++; throw new Error('lost receipt')
  }
  const preview = await service.request('s', connection, 'nacos-preview', input, 'user', send, () => {})
  const write = () => service.request('s', connection, 'nacos-write', { ...input, previewToken: preview.previewToken }, 'user', send, () => {})
  const outcomes = await Promise.allSettled([write(), write()])
  assert.equal(writes, 1)
  assert.ok(outcomes.some(result => result.reason?.executionStatus === 'unknown'))
  const old = executions.list('s')[0].executionId
  for (let i = 0; i < 105; i++) {
    const record = executions.create({ conversationId: 's', connectionId: 'c', operation: 'read' })
    executions.complete(record.executionId, 'succeeded')
  }
  assert.equal(executions.get('s', old), undefined)
  await assert.rejects(write(), /已执行/)
  assert.equal(writes, 1)
})

test('active connections survive restart per conversation and activation failure preserves selection', async t => {
  const root = temporaryDirectory(t, 'architecture-active-')
  const service = new ConnectionService(() => true, root)
  disposeAfter(root, service)
  const imported = service.importConnections('a', [connectionInput({ password: '', name: 'a' }), connectionInput({ password: '', name: 'b', host: 'b.test' })]).created
  const [a, b] = imported.map(row => row.id)
  service.activate('a', a); service.activate('b', b)
  assert.equal(service.snapshot('a').lastActiveId, a)
  assert.equal(service.snapshot('b').lastActiveId, b)
  const path = service.conversations.pathFor('a')
  rmSync(path); mkdirSync(path)
  assert.throws(() => service.activate('a', b))
  assert.equal(service.snapshot('a').lastActiveId, a)
  rmSync(path, { recursive: true }); service.activate('a', a)
  const restart = new ConnectionService(() => true, root)
  disposeAfter(root, restart)
  assert.equal(restart.snapshot('a').lastActiveId, a)
  assert.equal(restart.snapshot('b').lastActiveId, b)
  restart.activate('a')
  assert.equal(restart.snapshot('a').lastActiveId, undefined)
})

test('failed SQL and native knowledge commits preserve memory, version, search and disk', async t => {
  const root = temporaryDirectory(t, 'architecture-knowledge-')
  const store = new SqlTemplateStore(root)
  const saved = await store.publish({ sql: 'SELECT 1', dialect: 'mysql', connectionId: 'c', action: 'create', title: 'old' })
  await store.whenIdle()
  const before = store.get(saved.id)
  const disk = readFileSync(store.path, 'utf8')
  rmSync(store.path); mkdirSync(store.path)
  await assert.rejects(store.publish({ sql: 'SELECT 1', dialect: 'mysql', connectionId: 'c', action: 'mergeMeta', targetId: saved.id, title: 'ghost' }))
  assert.throws(() => store.archive(saved.id, saved.version))
  assert.deepEqual(store.get(saved.id), before)
  assert.throws(() => store.publishKnowledge({ sourceId: 'redis', connectionId: 'c', text: 'GET key', title: 'ghost' }))
  assert.deepEqual(store.searchKnowledge('redis', 'c'), [])
  rmSync(store.path, { recursive: true })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(store.path, disk)
  assert.deepEqual(new SqlTemplateStore(root).get(saved.id), { ...before, unpublished: !!before.unpublished })
})

test('connection import, copy, visible schemas and disconnect failures preserve authoritative profiles', async t => {
  const root = temporaryDirectory(t, 'architecture-profile-failure-')
  const service = new ConnectionService(() => true, root)
  disposeAfter(root, service)
  const connection = service.importConnections('a', [connectionInput({password:''})]).created[0]
  const before = service.snapshot('a')
  const path = join(root, 'database-workspace.json'), disk = readFileSync(path, 'utf8')
  rmSync(path); mkdirSync(path)
  assert.throws(() => service.importConnections('a', [connectionInput({password:'',host:'new.test'})]))
  await assert.rejects(service.duplicate('a', connection.id))
  assert.throws(() => service.saveWorkbench('a', connection.id, {visibleSchemas:['ghost']}))
  await assert.rejects(service.disconnect('a', connection.id))
  assert.deepEqual(service.snapshot('a'), before)
  rmSync(path, {recursive:true})
  const {writeFileSync} = await import('node:fs'); writeFileSync(path,disk)
  const restarted = new ConnectionService(() => true, root)
  disposeAfter(root, restarted)
  assert.deepEqual(restarted.snapshot('a').connections, before.connections)
})

test('async SQL parsing commits onto the latest knowledge snapshot without losing concurrent saves', async t => {
  const root = temporaryDirectory(t, 'architecture-parsing-')
  const store = new SqlTemplateStore(root)
  const base = await store.publish({sql:'SELECT 1',dialect:'mysql',connectionId:'c',action:'create'})
  await store.whenIdle()
  const version = store.publish({sql:'SELECT 2',dialect:'mysql',connectionId:'c',action:'newVersion',targetId:base.id,expectedVersion:base.version})
  const native = store.publishKnowledge({sourceId:'redis',connectionId:'c',text:'GET key',title:'concurrent'})
  await version
  const restarted = new SqlTemplateStore(root)
  assert.equal(restarted.list().length, 2)
  assert.equal(restarted.getKnowledge('redis',native.id,'c').title,'concurrent')
})

test('native result recovers after an event gap, stays off disk and cannot override an unknown terminal', async t => {
  const root = temporaryDirectory(t, 'architecture-result-')
  const store = new ExecutionStore(root)
  disposeAfter(root, store)
  const identity = { conversationId: 's', connectionId: 'c', generation: 'g', sourceId: 'redis', context: {}, queryRevision: 1, documentText: 'GET private', executedSql: 'GET private', initiator: 'user' }
  const row = store.create({ conversationId: 's', connectionId: 'c', generation: 'g', dialect: 'redis', operation: 'command', identity })
  store.complete(row.executionId, 'succeeded', 'done', undefined, undefined, { sourceId: 'redis', kind: 'resp', status: 'succeeded', truncated: false, payload: { result: { type: 'string', value: 'private-value' } } })
  for (let i = 0; i < 90; i++) store.emitWorkbench('s', { type: 'EXECUTION_STARTED', identity })
  assert.equal((await store.wait('s', 1, 0)).gap, true)
  assert.equal(store.latestDisplay('s', 'c').resultEnvelope.payload.result.value, 'private-value')
  assert.doesNotMatch(readFileSync(join(root, 'ai-executions.json'), 'utf8'), /private-value/)
  const unknown = store.create({ conversationId: 's', connectionId: 'c', dialect: 'redis', operation: 'command' })
  store.complete(unknown.executionId, 'unknown')
  store.complete(unknown.executionId, 'succeeded', '', undefined, undefined, { sourceId: 'redis', kind: 'resp', status: 'succeeded', truncated: false, payload: { value: 'late' } })
  assert.equal(store.get('s', unknown.executionId, true).resultEnvelope, undefined)
  const pending = store.wait('s', store.clock('s'), 10000)
  store.releaseConversation('s')
  assert.equal((await pending).events.length, 0)
  assert.equal(store.get('s', row.executionId, true).resultEnvelope, undefined)
})

test('abrupt process exit after asynchronous dispatch persistence recovers as unknown without replay', async t => {
  const root = temporaryDirectory(t, 'architecture-crash-')
  const moduleUrl = new URL('../src/host/execution-store.ts', import.meta.url).href
  const script = `import {ExecutionStore} from ${JSON.stringify(moduleUrl)};
    import {readFileSync} from 'node:fs'; import {join} from 'node:path';
    const store = new ExecutionStore(${JSON.stringify(root)}, 'async');
    const row = store.create({conversationId:'s',connectionId:'c',operation:'write'});
    store.event(row.executionId,'dispatched'); store.transition(row.executionId,'running');
    for(let i=0;i<200;i++){try{if(JSON.parse(readFileSync(join(${JSON.stringify(root)},'ai-executions.json'),'utf8')).records[0]?.status==='running')process.exit(23)}catch{}
      await new Promise(resolve=>setTimeout(resolve,5))} process.exit(24);`
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000, windowsHide: true })
  assert.equal(child.status, 23, child.stderr)
  const restarted = new ExecutionStore(root)
  disposeAfter(root, restarted)
  assert.equal(restarted.list('s')[0].status, 'unknown')
  assert.equal(restarted.list('s').length, 1)
})

test('owner release archives drafts and cleans late execution events while retaining shared profiles', async t => {
  const root = temporaryDirectory(t, 'architecture-release-')
  const executions = new ExecutionStore(root)
  const service = new ConnectionService(() => true, root, undefined, undefined, executions)
  disposeAfter(root, service)
  const connection = service.importConnections('a', [connectionInput({ password: '' })]).created[0]
  service.activate('a', connection.id)
  service.saveWorkbench('a', connection.id, { queryTabs: [{id:'tab',name:'draft',sql:'SELECT 1'}] })
  const record = executions.create({conversationId:'a',connectionId:connection.id,operation:'query'})
  const wait = executions.wait('a', executions.clock('a'), 10000)
  await service.releaseOwner('a')
  assert.deepEqual((await wait).events, [])
  executions.event(record.executionId, 'late-result', 'late')
  assert.deepEqual((await executions.wait('a', 0, 0)).events, [])
  assert.equal(service.snapshot('b').connections[0].id, connection.id)
  assert.equal(service.snapshot('a').connections[0].workbench?.queryTabs, undefined)
  const { readdirSync } = await import('node:fs')
  assert.equal(readdirSync(join(root, 'removed-conversation-workbenches')).filter(name => name.endsWith('.json')).length, 1)
})

test('connection health listeners ignore malformed messages and reject malformed correlated receipts', async t => {
  const root = temporaryDirectory(t, 'architecture-worker-header-')
  class Worker extends EventEmitter {
    postMessage(message) {
      queueMicrotask(() => this.emit('message', message.requestId ? { requestId: message.requestId, error: 42 }
        : { ready: true, result: {version:'fixture',database:'app',databases:['app'],health:'ready'} }))
    }
    async terminate() { this.emit('exit',0); return 0 }
  }
  const worker = new Worker()
  const service = new ConnectionService(() => true,root,undefined,undefined,undefined,undefined,() => worker)
  disposeAfter(root,service)
  const connection = await service.open('a',connectionInput(),false)
  assert.doesNotThrow(() => { worker.emit('message',null); worker.emit('message',{health:42}); worker.emit('message',{closed:'false'}) })
  assert.equal(service.snapshot('a').connections[0].live,true)
  await assert.rejects(service.executeText('a',connection.id,connection.generation,'SELECT 1'),error => error.code === 'PROTOCOL_INVALID' && error.effect === 'unknown')
})

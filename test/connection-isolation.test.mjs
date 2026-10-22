import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { ConnectionService } from '../src/host/connection-service.ts'
import { memoryPasswordProtector } from '../src/host/saved-connections.ts'
import { connectionInput, temporaryDirectory } from './helpers.mjs'
import { mergeWorkspaceConnections } from '../src/client/schema/refresh.ts'

function setup(t) {
  const workers = [], gates = new Map()
  class FixtureWorker extends EventEmitter {
    requests = []
    terminated = false
    postMessage(message) {
      if (message.cancel) { if (!this.ignoreCancel) this.emit('message', { requestId: message.requestId, cancelled: true }); return }
      if (!message.requestId) {
        const reply = () => this.emit('message', { ready: true, result: { version: 'fixture', database: 'app', databases: [], elapsedMs: 1 } })
        if (gates.has(message.input.name)) gates.get(message.input.name).push(reply)
        else queueMicrotask(reply)
      } else this.requests.push(message)
    }
    async terminate() { if (!this.terminated) { this.terminated = true; this.emit('exit', 0) } return 0 }
    reply() { for (const request of this.requests.splice(0)) this.emit('message', { requestId: request.requestId, result: { items: [] }, health: 'ready' }) }
  }
  const service = new ConnectionService(() => true, temporaryDirectory(t, 'connection-isolation-'), undefined, memoryPasswordProtector, undefined, undefined,
    () => { const worker = new FixtureWorker(); workers.push(worker); return worker })
  t.after(() => service.dispose())
  return { service, workers, gates }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('disconnect cancels an offline profile connection attempt and ignores late ready', async t => {
  const { service, gates } = setup(t)
  const first = await service.open('owner', connectionInput(), false)
  await service.disconnect('owner', first.id)
  gates.set('slow', [])
  const pending = service.update('owner', first.id, connectionInput({ name: 'slow' }))
  const settled = pending.catch(error => error)
  await tick()
  await service.disconnect('owner', first.id)
  for (const release of gates.get('slow')) release()
  assert.ok(await settled instanceof Error)
  assert.equal(service.list('owner')[0].live, false)
  assert.equal(service.list('owner')[0].desiredState, 'offline')
})

test('same connection update is reserved before the first await', async t => {
  const { service, workers, gates } = setup(t)
  const first = await service.open('owner', connectionInput(), false)
  gates.set('slow', [])
  const pending = service.update('owner', first.id, connectionInput({ name: 'slow' }))
  const duplicate = service.update('owner', first.id, connectionInput({ name: 'slow' }))
  await assert.rejects(duplicate, /正在|busy/)
  await tick()
  assert.equal(workers.length, 2)
  gates.get('slow').forEach(release => release())
  await pending
})

test('simultaneous reads atomically reserve the per connection quota', async t => {
  const { service, workers } = setup(t)
  const first = await service.open('owner', connectionInput(), false)
  const reads = Array.from({ length: 4 }, () => service.request('owner', first.id, first.generation, 'browse', { schema: 'app' }))
  await tick()
  assert.equal(workers[0].requests.length, 3)
  workers[0].reply()
  await tick()
  assert.equal(workers[0].requests.length, 1)
  workers[0].reply()
  await Promise.all(reads)
})

test('idle worker errors only take their connection offline', async t => {
  const { service, workers } = setup(t)
  const first = await service.open('owner', connectionInput(), false)
  const second = await service.open('owner', connectionInput({ name: 'other' }), false)
  assert.doesNotThrow(() => workers[0].emit('error', new Error('fixture worker crashed')))
  assert.equal(service.list('owner').find(row => row.id === first.id).live, false)
  assert.equal(service.list('owner').find(row => row.id === second.id).live, true)
})

test('background start is idempotent and independent of another slow handshake', async t => {
  const { service, workers, gates } = setup(t)
  gates.set('slow', [])
  const started = service.startConnection('owner', connectionInput({ name: 'slow' }), 'operation-a')
  const repeated = service.startConnection('owner', connectionInput({ name: 'slow' }), 'operation-a')
  assert.equal(started.connectionId, repeated.connectionId)
  await tick()
  const fast = await service.open('owner', connectionInput({ name: 'fast' }), false)
  assert.equal(fast.live, true)
  assert.equal(workers.length, 2)
  await service.cancelConnection('owner', started.connectionId, started.operationId)
  gates.get('slow').forEach(release => release())
  await tick()
  const row = service.list('owner').find(row => row.id === started.connectionId)
  assert.equal(row.live, false)
  assert.equal(row.lifecycle.status, 'cancelled')
})

test('status restore cannot reconnect an explicitly disconnected remembered profile', async t => {
  const { service, workers } = setup(t)
  const first = await service.open('owner', connectionInput({ rememberPassword: true }), false)
  await service.disconnect('owner', first.id)
  await service.restoreRemembered('owner')
  await tick()
  assert.equal(workers.length, 1)
  assert.equal(service.list('owner')[0].live, false)
})

test('network recovery continues beyond four attempts then stops on authentication', async t => {
  const { service, workers } = setup(t)
  const first = await service.open('owner', connectionInput({rememberPassword:true}), false)
  t.mock.timers.enable({apis:['setTimeout','Date'], now:1000})
  workers[0].emit('message', {health:'degraded', category:'network'})
  for (let index = 0; index < 8; index++) {
    const row = service.list('owner')[0]
    const delay = row.lifecycle.nextRetryAt - Date.now()
    const expected = [500,1000,2000,5000,15000,30000,60000,60000][index]
    assert.ok(delay >= expected * .8 && delay <= expected * 1.2)
    t.mock.timers.tick(delay)
    await tick()
    const request = workers[0].requests.shift()
    assert.equal(request.action, 'revive')
    workers[0].emit('message', {requestId:request.requestId, error:'ECONNRESET', connectionCategory:'network', health:'degraded'})
    await tick()
    assert.equal(service.list('owner')[0].generation, first.generation)
  }
  t.mock.timers.tick(service.list('owner')[0].lifecycle.nextRetryAt - Date.now())
  await tick()
  const request = workers[0].requests.shift()
  workers[0].emit('message', {requestId:request.requestId, error:'wrong password', connectionCategory:'authentication', health:'degraded'})
  await tick()
  assert.equal(service.list('owner')[0].lifecycle.nextRetryAt, undefined)
  t.mock.timers.tick(300_000)
  await tick()
  assert.equal(workers[0].requests.length, 0)
})

test('failed and cancelled candidates preserve the original online worker and settings', async t => {
  const { service, workers, gates } = setup(t)
  const original = await service.open('owner', connectionInput(), false)
  gates.set('candidate', [])
  const operation = service.startConnection('owner', connectionInput({name:'candidate'}), 'candidate-op', original.id)
  await tick()
  await service.cancelConnection('owner', original.id, operation.operationId)
  gates.get('candidate').forEach(release => release())
  await tick()
  const row = service.list('owner')[0]
  assert.equal(row.generation, original.generation)
  assert.equal(row.name, original.name)
  assert.equal(row.live, true)
  assert.equal(workers[0].terminated, false)
  assert.equal(workers[1].terminated, true)
})

test('snapshot merge observes lifecycle even when availability has not changed', () => {
  const row = {id:'a', live:false, health:'offline', lifecycle:{operationId:'op',kind:'connect',status:'queued'}}
  const fresh = {...row, lifecycle:{...row.lifecycle,status:'running'}}
  assert.equal(mergeWorkspaceConnections([row], [fresh])[0].lifecycle.status, 'running')
})

test('a native operation that ignores cancellation is quarantined and only its worker is retired', async t => {
  const {service, workers} = setup(t)
  const a = await service.open('owner', connectionInput(), false)
  const b = await service.open('owner', connectionInput({name:'b'}), false)
  workers[0].ignoreCancel = true
  t.mock.timers.enable({apis:['setTimeout','Date'], now:1000})
  const controller = new AbortController()
  const pending = service.request('owner',a.id,a.generation,'browse',{schema:'app'},controller.signal)
  await tick()
  controller.abort()
  await assert.rejects(pending, /取消/)
  const blocked = service.request('owner',a.id,a.generation,'browse',{schema:'app'})
  const rejected = assert.rejects(blocked)
  await tick()
  assert.equal(workers[0].requests.length,1,'quarantine must prevent piling up native work')
  t.mock.timers.tick(1000)
  await rejected
  assert.equal(workers[0].terminated,true)
  assert.equal(service.list('owner').find(row => row.id === b.id).live,true)
  assert.equal(workers[1].terminated,false)
})

test('deleting an accepted profile prevents late success and snapshots cannot alter runtime state', async t => {
  const {service,gates} = setup(t)
  gates.set('slow',[])
  const started = service.startConnection('owner',connectionInput({name:'slow'}),'delete-op')
  const snapshot = service.list('owner')[0]
  snapshot.lifecycle.status = 'succeeded'
  assert.throws(() => service.startConnection('owner',connectionInput(),'another-op',started.connectionId), error => error.code === 'connection_busy')
  await tick()
  await service.remove('owner',started.connectionId)
  gates.get('slow').forEach(release => release())
  await tick()
  assert.equal(service.list('owner').length,0)
})

test('failed update validation leaves the old worker and configuration intact', async t => {
  const {service,workers,gates} = setup(t)
  const original = await service.open('owner',connectionInput(),false)
  gates.set('candidate',[])
  const pending = service.update('owner',original.id,connectionInput({name:'candidate'}))
  const rejected = assert.rejects(pending,/invalid configuration/)
  await tick()
  workers[1].emit('message',{ready:false,error:'invalid configuration',category:'configuration'})
  await rejected
  const row = service.list('owner')[0]
  assert.equal(row.name,original.name); assert.equal(row.generation,original.generation); assert.equal(row.live,true)
  assert.equal(workers[0].terminated,false); assert.equal(workers[1].terminated,true)
})

test('pending logical connections reserve the twenty connection limit synchronously', async t => {
  const {service,gates,workers} = setup(t)
  gates.set('slow',[])
  for (let i = 0; i < 20; i++) service.startConnection('owner',connectionInput({name:'slow'}),'limit-'+i)
  assert.throws(() => service.startConnection('owner',connectionInput(),'overflow'),error => error.code === 'connection_busy')
  await tick()
  assert.equal(workers.length,6)
  assert.equal(service.list('owner').length,20)
})

test('Host limits preloads across workbenches and admits another connection foreground read', async t => {
  const {service,workers} = setup(t)
  const connections = await Promise.all(Array.from({length:6},(_,i)=>service.open('owner',connectionInput({name:String(i)}),false)))
  const preloads = connections.slice(0,5).map(row => service.catalog('owner',row.id,row.generation,{kind:'schemas',background:true}))
  await tick()
  assert.equal(workers.reduce((sum,worker)=>sum+worker.requests.length,0),4)
  const foreground = service.catalog('owner',connections[5].id,connections[5].generation,{kind:'schemas'})
  await tick()
  assert.equal(workers[5].requests.length,1)
  workers[5].reply(); await foreground
  workers[0].reply(); await tick()
  assert.equal(workers[4].requests.length,1)
  workers.forEach(worker=>worker.reply()); await Promise.all(preloads)
})

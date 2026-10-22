import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {workerExchange} from '../src/host/worker-exchange.ts'

test('worker transport ignores unrelated malformed messages and rejects invalid correlated headers', async () => {
 const worker = new EventEmitter()
 const outcome = workerExchange(worker, 'a', 100, undefined, finish => ({
  message: reply => finish(undefined, reply.result), exit: () => finish(Error('exit')), timeout: () => finish(Error('timeout')),
  send: () => { worker.emit('message', null); worker.emit('message', {requestId:'other', error:42}); worker.emit('message', {requestId:'a', cancelled:'false'}) },
 }))
 await assert.rejects(outcome, error => error.code === 'PROTOCOL_INVALID' && error.effect === 'unknown')
 assert.equal(worker.listenerCount('message'), 0)
 assert.equal(worker.listenerCount('error'), 0)
})
import {registerNavigationGuard,allowNavigation} from '../src/client/workspace/parts/navigation-guard.ts'
test('worker exchange isolates request ids, keeps progress nonterminal and releases listeners',async()=>{
 const worker=new EventEmitter(),seen=[]
 const result=workerExchange(worker,'a',100,undefined,finish=>({message:reply=>{seen.push(reply);if(reply.result)finish(undefined,reply.result)},exit:()=>finish(Error('exit')),timeout:()=>finish(Error('timeout')),send:()=>{worker.emit('message',{requestId:'b',result:'wrong'});worker.emit('message',{requestId:'a',progress:1});queueMicrotask(()=>worker.emit('message',{requestId:'a',result:'right'}))}}))
 assert.equal(await result,'right');assert.equal(seen.length,2);assert.equal(worker.listenerCount('message'),0);assert.equal(worker.listenerCount('exit'),0)
})
test('worker exchange cleans abort and timeout handlers; late replies cannot settle twice',async()=>{
 for(const mode of ['abort','timeout','exit','send']){const worker=new EventEmitter(),controller=new AbortController();let finishes=0
 const result=workerExchange(worker,'a',5,controller.signal,finish=>({message:reply=>{finishes++;finish(undefined,reply.result)},exit:()=>finish(Error('exit')),timeout:()=>finish(Error('timeout')),abort:()=>finish(Error('abort')),send:()=>{if(mode==='send')throw Error('send');if(mode==='abort')controller.abort();if(mode==='exit')worker.emit('exit')}}))
 await assert.rejects(result,new RegExp(mode));worker.emit('message',{requestId:'a',result:'late'});assert.equal(finishes,0);assert.equal(worker.listenerCount('message'),0);assert.equal(worker.listenerCount('exit'),0)}
})
test('navigation cancellation stops action and guard cleanup is isolated by owner',async()=>{
 const stopA=registerNavigationGuard('a','draft',()=>false),stopB=registerNavigationGuard('b','draft',()=>true)
 assert.equal(await allowNavigation('a'),false);assert.equal(await allowNavigation('b'),true);stopA();assert.equal(await allowNavigation('a'),true);stopB()
})


test('worker exchange refuses already-aborted sends and safely handles setup settlement',async()=>{
 const worker=new EventEmitter(),controller=new AbortController();controller.abort();let sends=0
 await assert.rejects(workerExchange(worker,'a',100,controller.signal,finish=>({message:()=>{},exit:()=>finish(Error()),timeout:()=>finish(Error()),send:()=>sends++})),/取消/)
 assert.equal(sends,0);assert.equal(worker.listenerCount('error'),0)
 assert.equal(await workerExchange(worker,'a',100,undefined,finish=>{finish(undefined,'early');return {message:()=>{},exit:()=>{},timeout:()=>{},send:()=>sends++}}),'early')
 assert.equal(sends,0);assert.equal(worker.listenerCount('message'),0)
})

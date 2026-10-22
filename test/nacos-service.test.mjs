import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {NacosService} from '../src/host/nacos-service.ts'
import {applyPublicEdits,protectedConfig,aiProjection} from '../src/host/data-sources/nacos/config-protection.mjs'
import {NacosHttpClient} from '../src/host/data-sources/nacos/http-client.mjs'
import {createRequestScope} from '../src/client/workspace/parts/request-scope.ts'
const hash = text => createHash('md5').update(text).digest('hex')
const connection = {id:'c',generation:'g',name:'Nacos',dialect:'nacos',environment:'sit',live:true}
const target = {namespaceId:'',group:'G',dataId:'app.yaml'}
const input = {host:'127.0.0.1',port:8848,username:'admin',password:'secret'}
const reply = value => new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}})

test('latest request cancels only its lane; identity invalidates all lanes', () => {
  const scope=createRequestScope('a'),first=scope.latest('detail'),child=scope.latest('child'),next=scope.latest('detail')
  assert.equal(first.signal.aborted,true); assert.equal(scope.isCurrent(child),true); assert.equal(scope.isCurrent(next),true)
  scope.invalidate('b');assert.equal(child.signal.aborted,true);assert.equal(next.signal.aborted,true)
})
test('format-aware public edits preserve secret bytes and reject field deletion, ambiguity, aliases and malformed content', () => {
  const text='password: "abc"\nport: 8080\n'
  assert.equal(applyPublicEdits(text,'yaml',[{oldText:'8080',newText:'9090'}]),'password: "abc"\nport: 9090\n')
  assert.doesNotMatch(protectedConfig(text,'yaml').text,/abc/)
  assert.throws(()=>applyPublicEdits(text,'yaml',[{oldText:'password: "abc"',newText:''}]))
  assert.throws(()=>applyPublicEdits('x: 1\ny: 1','yaml',[{oldText:'1',newText:'2'}]))
  assert.equal(protectedConfig('a: &a 1\nb: *a','yaml').safe,false)
  assert.equal(protectedConfig('{','json').safe,false)
  assert.throws(()=>applyPublicEdits('{"a":1}','json',[{oldText:'1',newText:'1,"token":"x"'}]))
  assert.equal(protectedConfig('password=x\nport=80','properties').text,'[REDACTED]\nport=80')
  assert.equal(aiProjection({metadata:{password:'x'},content:'{"token":"s"}',type:'json'}).metadata.password,'[REDACTED]')
})
test('same service enforces SIT, signed preview, version and exact changes before write', async () => {
  const service=new NacosService();let text='password: abc\nport: 80\n',writes=0
  const send=async(action,request,signal,dispatched)=>{if(action==='nacos-config')return {content:text,md5:hash(text),type:'yaml'};dispatched?.();writes++;text=request.content;return {saved:true}}
  const change={...target,kind:'update',type:'yaml',expectedMd5:hash(text),edits:[{oldText:'80',newText:'81'}]}
  const preview=await service.request('s',connection,'nacos-preview',change,'ai',send,()=>{})
  assert.doesNotMatch(preview.before,/abc/);assert.doesNotMatch(preview.after,/abc/)
  await assert.rejects(service.request('s',{...connection,environment:'uat'},'nacos-preview',change,'ai',send,()=>{}),/SIT/)
  await assert.rejects(service.request('other',connection,'nacos-write',{...change,previewToken:preview.previewToken},'ai',send,()=>{}),/变化/)
  await assert.rejects(service.request('s',connection,'nacos-write',{...change,edits:[{oldText:'80',newText:'82'}],previewToken:preview.previewToken},'ai',send,()=>{}),/变化/)
  assert.equal(writes,0)
  await service.request('s',connection,'nacos-write',{...change,previewToken:preview.previewToken},'ai',send,()=>{})
  assert.equal(text,'password: abc\nport: 81\n');assert.equal(writes,1)
  await assert.rejects(service.request('s',connection,'nacos-write',{...change,previewToken:preview.previewToken},'ai',send,()=>{}),/版本冲突/)
})
test('human UAT writes are allowed and post-dispatch missing acknowledgement is unknown without replay', async () => {
  const service=new NacosService(),current='a=1',change={...target,kind:'update',type:'properties',expectedMd5:hash(current),content:'a=2'}
  let sends=0
  const send=async(action,request,signal,dispatched)=>{if(action==='nacos-config')return {content:current,md5:hash(current),type:'properties'};sends++;dispatched();throw new Error('lost receipt')}
  const preview=await service.request('s',{...connection,environment:'uat'},'nacos-preview',change,'user',send,()=>{})
  await assert.rejects(service.request('s',{...connection,environment:'uat'},'nacos-write',{...change,previewToken:preview.previewToken},'user',send,()=>{}),e=>e.executionStatus==='unknown')
  assert.equal(sends,1)
})
test('HTTP refresh is coalesced, reads retry once, writes and forbidden reads never retry', async () => {
  let logins=0,reads=0,writes=0
  const client=new NacosHttpClient(input,{fetch:async(url,init)=>{
    if(url.pathname.endsWith('/login')){logins++;await new Promise(r=>setTimeout(r,10));return reply({accessToken:'T'})}
    if(init.method==='POST'){writes++;return new Response('',{status:401})}
    reads++;return url.searchParams.has('accessToken')?reply({code:0,data:{ok:true}}):new Response('',{status:401})
  }})
  await Promise.all([client.request('/v2/cs/config'),client.request('/v2/cs/config')])
  assert.equal(logins,1);assert.equal(reads,4)
  await assert.rejects(client.request('/v2/cs/config',{method:'POST',body:{content:'x'}}),/401/);assert.equal(writes,1)
  const forbidden=new NacosHttpClient(input,{fetch:async()=>new Response('password=secret',{status:403})})
  await assert.rejects(forbidden.request('/v2/cs/config'),e=>e.code==='permission'&&!e.message.includes('secret'))
})
test('HTTP client rejects redirect, oversized body and timeout without exposing raw error content', async () => {
  await assert.rejects(new NacosHttpClient(input,{fetch:async()=>new Response('',{status:302})}).request('/v2/cs/config'),e=>e.code==='redirect')
  await assert.rejects(new NacosHttpClient(input,{fetch:async()=>new Response('x'.repeat(2*1024*1024+1))}).request('/v2/cs/config',{text:true}),e=>e.code==='too-large')
  await assert.rejects(new NacosHttpClient(input,{timeoutMs:10,fetch:(_url,init)=>new Promise((_r,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason)))}).request('/v2/cs/config'),e=>e.code==='timeout')
})

test('real 2.4.3 CAS code, empty show-all, expired 403 and unsupported errors are bounded and safe',async()=>{
 await assert.rejects(new NacosHttpClient(input,{fetch:async()=>new Response(JSON.stringify({code:20005,message:'secret'}),{status:500})}).request('/v2/cs/config',{method:'POST',body:{content:'x'}}),e=>e.code==='conflict'&&!e.message.includes('secret'))
 assert.equal(await new NacosHttpClient(input,{fetch:async()=>new Response('')}).request('/v1/cs/configs',{allowMissing:true}),null)
 let logins=0,reads=0;const client=new NacosHttpClient(input,{fetch:async(url,init)=>{if(init.method==='POST'){logins++;return reply({accessToken:'new'})}reads++;return reads===1?new Response('token expired!',{status:403}):reply({ok:true})}})
 assert.deepEqual(await client.request('/v2/cs/config'),{ok:true});assert.equal(reads,2);assert.equal(logins,1)
 assert.equal(protectedConfig('{"port":1,"port":2}','json').safe,false)
})
test('signed preview expires, binds actor and generation; encrypted deletion stays an authorized operation',async()=>{
 const service=new NacosService(),before={content:'password: s',type:'yaml',md5:'m',encrypted:true},change={...target,kind:'delete',expectedMd5:'m'}
 const send=async(action,_input,_signal,dispatched)=>{if(action==='nacos-config')return before;dispatched?.();return {saved:true}}
 const preview=await service.request('s',connection,'nacos-preview',change,'ai',send,()=>{})
 await assert.rejects(service.request('s',{...connection,generation:'next'},'nacos-write',{...change,previewToken:preview.previewToken},'ai',send,()=>{}),/变化/)
 await assert.rejects(service.request('s',connection,'nacos-write',{...change,previewToken:preview.previewToken},'user',send,()=>{}),/变化/)
 const clock=Date.now;Date.now=()=>clock()+300001;try{await assert.rejects(service.request('s',connection,'nacos-write',{...change,previewToken:preview.previewToken},'ai',send,()=>{}),/过期/)}finally{Date.now=clock}
 assert.equal((await service.request('s',connection,'nacos-write',{...change,previewToken:preview.previewToken},'ai',send,()=>{})).executionStatus,'succeeded')
})


test('cancelled refresh waiter does not abort a concurrent reader login',async()=>{
 const controller=new AbortController();let logins=0,release
 const client=new NacosHttpClient(input,{fetch:async(url)=>{if(url.pathname.endsWith('/login')){logins++;await new Promise(r=>release=r);return reply({accessToken:'T'})}return reply({ok:true})}})
 const cancelled=client.login(controller.signal),other=client.login()
 controller.abort();await assert.rejects(cancelled,e=>e.code==='cancelled');release();await other
 assert.equal(logins,1);assert.deepEqual(await client.request('/v2/cs/config'),{ok:true})
})

test('unknown write consumes its preview in the existing execution ledger without replay',async()=>{
 const {ExecutionStore}=await import('../src/host/execution-store.ts')
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
 const directory=await mkdtemp(join(tmpdir(),'nacos-replay-')),store=new ExecutionStore(directory),service=new NacosService(store)
 const change={...target,kind:'update',content:'a=2',type:'properties',expectedMd5:hash('a=1')};let sends=0
 const send=async(action,_input,_signal,dispatched)=>{if(action==='nacos-config')return {content:'a=1',type:'properties',md5:hash('a=1')};sends++;dispatched();throw Error('lost receipt')}
 try{const preview=await service.request('s',connection,'nacos-preview',change,'user',send,()=>{})
 await assert.rejects(service.request('s',connection,'nacos-write',{...change,previewToken:preview.previewToken},'user',send,()=>{}),e=>e.executionStatus==='unknown')
 await assert.rejects(service.request('s',connection,'nacos-write',{...change,previewToken:preview.previewToken},'user',send,()=>{}),/已执行/)
 assert.equal(sends,1);assert.equal(store.list('s')[0].status,'unknown')
 }finally{await store.dispose();await rm(directory,{recursive:true,force:true})}
})


test('serialized UTF-8 size guard refuses large changes before reads or writes',async()=>{
 const service=new NacosService();let sends=0;const send=async()=>{sends++;return {}}
 await assert.rejects(service.request('s',connection,'nacos-preview',{...target,kind:'create',type:'yaml',content:'汉'.repeat(180000)},'user',send,()=>{}),/512 KiB/)
 assert.equal(sends,0)
 const {nacosModule}=await import('../src/host/data-sources/nacos/module.ts')
 await assert.rejects(async()=>nacosModule.connection.validate({name:'n',dialect:'nacos',host:'localhost',port:8848,database:'',username:'',password:'',protocol:'ftp'}),/协议/)
})


test('pre-dispatch version conflicts supply a definite no-write HTTP receipt',async()=>{
 const service=new NacosService();let writes=0
 const send=async(action)=>{if(action==='nacos-config')return {content:'a=1',md5:'new',type:'properties'};writes++}
 await assert.rejects(service.request('s',connection,'nacos-write',{...target,kind:'update',type:'properties',content:'a=2',expectedMd5:'old',previewToken:'invalid'},'user',send,()=>{}),e=>e.effect==='none'&&e.phase==='check')
 assert.equal(writes,0)
 const {connectionBridge}=await import('../src/client/connection-bridge.ts')
 const original=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({error:'配置版本冲突',effect:'none',phase:'check'}),{status:400})
 try{await assert.rejects(connectionBridge('s',{}).sourceRequest(connection,'nacos-request',{operation:'nacos-write'}),e=>e.effect==='none'&&e.trustedReceipt===true)}finally{globalThis.fetch=original}
})

test('credential values protect their fields while independent nonsecret edits remain available',()=>{
 for(const[type,text]of [['yaml','endpoint: redis://:keep-private@localhost:6379\nport: 80\n'],['json','{"endpoint":"redis://:keep-private@localhost:6379","port":80}'],['properties','endpoint=redis://:keep-private@localhost:6379\nport=80']]){
  assert.doesNotMatch(protectedConfig(text,type).text,/keep-private/)
  assert.match(applyPublicEdits(text,type,[{oldText:'80',newText:'81'}]),/keep-private/)
  assert.throws(()=>applyPublicEdits(text,type,[{oldText:'keep-private',newText:'changed'}]))
 }
 assert.equal(protectedConfig('!!str port: 80','yaml').safe,false)
 assert.equal(protectedConfig('port=80\nport=81','properties').safe,false)
 assert.doesNotMatch(protectedConfig('authorization: Bearer abcdefgh\nport: 80','yaml').text,/abcdefgh/)
})

test('publish checks JSON, YAML and Properties before preview or write and skips text and delete', async () => {
  const service = new NacosService()
  let writes = 0
  const missing = async action => { if (action === 'nacos-config') throw Object.assign(new Error('missing'), {category: 'not-found'}); writes++; return {saved: true} }
  const samples = [['json', '{'], ['json', '{"a":1,"a":2}'], ['yaml', 'password: secret\n['], ['yml', 'password: secret\n['], ['properties', 'key=\\u12']]
  for (const [type, content] of samples) {
    for (const actor of ['user', 'ai']) {
      const change = {...target, kind: 'create', type, content}
      await assert.rejects(service.request('s', connection, 'nacos-preview', change, actor, missing, () => {}), error => /格式错误/.test(error.message) && !error.message.includes('secret'))
      await assert.rejects(service.request('s', connection, 'nacos-write', {...change, previewToken: 'bad'}, actor, missing, () => {}), /格式错误/)
    }
  }
  assert.equal(writes, 0)
  const text = await service.request('s', connection, 'nacos-preview', {...target, kind: 'create', type: 'text', content: '{'}, 'user', missing, () => {})
  assert.ok(text.previewToken)
  const current = 'not json {'
  const existing = async action => { if (action === 'nacos-config') return {content: current, md5: hash(current), type: 'json'}; writes++; return {saved: true} }
  const deletion = {...target, kind: 'delete', type: 'json', content: '{', expectedMd5: hash(current)}
  const preview = await service.request('s', connection, 'nacos-preview', deletion, 'user', existing, () => {})
  assert.ok(preview.previewToken)
  assert.equal(writes, 0)
})

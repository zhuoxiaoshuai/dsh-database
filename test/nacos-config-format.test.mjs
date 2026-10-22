import test from 'node:test'
import assert from 'node:assert/strict'
import {validateNacosConfigFormat as validate, diagnoseNacosConfigFormat as diagnose} from '../src/shared/nacos-config-format.mjs'
import {NacosService} from '../src/host/nacos-service.ts'
import {NACOS_CONFIG_TYPES,normalizeNacosConfigType,resolveNacosConfigType,nacosConfigValidationNote} from '../src/shared/nacos-config-types.mjs'

test('JSON and YAML validate syntax without exposing content in diagnostics',()=>{
  for(const [type,content] of [['json','{"port":80}'],['json','[1,true,null]'],['yaml','a: &a 1\nb: *a\n'],['yaml','a: 1\n---\na: 2']])assert.doesNotThrow(()=>validate(content,type))
  for(const [type,content] of [['json','{"password":"secret",}'],['json','{"port":1,"port":2}'],['json',''],['yaml','password: [secret'],['yaml','a: 1\na: 2']])assert.throws(()=>validate(content,type),e=>/格式错误.*行.*列/.test(e.message)&&!e.message.includes('secret'))
})
test('Properties accepts Java escapes, continuations, empty and repeated keys but rejects malformed Unicode',()=>{
  for(const content of ['','flag','x=','x=1\nx=2','# \\uINVALID\nx=1','path=C:\\folder','a\\ b=value','x=\\u4e2d','x=one\\\n  two','x=\\\\uNOTUNICODE'])assert.doesNotThrow(()=>validate(content,'properties'))
  for(const content of ['x=\\u12','x=\\u12GG','x=\\u123','# comment\\\nnext=\\uGGGG','x=\\\rnext=\\uGGGG','x=one\\\n  \\uNOPE'])assert.throws(()=>validate(content,'properties'),/Properties 格式错误/)
  assert.doesNotThrow(()=>validate('not structured at all','text'))
})
test('Host validates both preview and execution while deletion does not validate old malformed content',async()=>{
  const service=new NacosService(),connection={id:'c',generation:'g',name:'n',dialect:'nacos',environment:'sit',live:true}
  const base={namespaceId:'',group:'G',dataId:'a.json',expectedMd5:'m',kind:'update',type:'json',content:'{"secret":'}
  let writes=0
  const send=async action=>{if(action==='nacos-config')return {content:'{malformed',type:'json',md5:'m'};writes++;return {saved:true}}
  for(const action of ['nacos-preview','nacos-write'])await assert.rejects(service.request('owner',connection,action,base,'user',send,()=>{}),/JSON 格式错误/)
  assert.equal(writes,0)
  const change={...base,kind:'delete'},preview=await service.request('owner',connection,'nacos-preview',change,'user',send,()=>{})
  await service.request('owner',connection,'nacos-write',{...change,previewToken:preview.previewToken},'user',send,()=>{})
  assert.equal(writes,1)
})

test('structured diagnostics locate multiple errors without leaking source, including CRLF and continuations',()=>{
  const source='{\r\n  "secret": 1,\r\n  "secret": 2,\r\n  "nested": {"a":1,"a":2}\r\n}'
  const issues=diagnose(source,'json')
  assert.equal(issues.length,2)
  assert.deepEqual([issues[0].line,issues[0].column,issues[0].from],[3,3,source.indexOf('"secret": 2')])
  assert.equal(issues[1].line,4)
  assert.equal(JSON.stringify(issues).includes('secret'),false)
  assert.equal(diagnose('a: 1\na: 2\nb: 1\nb: 2','yaml').filter(i=>i.code==='DUPLICATE_KEY').length,2)
  const props=diagnose('x=one\\\r\n  \\uNOPE','properties')
  assert.deepEqual([props[0].line,props[0].column],[2,3])
  assert.equal(diagnose('a: 1\n'.repeat(500),'yaml').length,100)
})

test('YAML config requires mappings in every document while preserving nested lists, anchors and multiple documents',()=>{
  for(const content of ['222\nkkk\nkkk kkk\n\n333','', '# comment','null','- item','a: 1\n---\njust text']){
    assert.equal(diagnose(content,'yaml')[0].code,'CONFIG_ROOT')
    assert.throws(()=>validate(content,'yaml'),/顶层键值对象/)
  }
  for(const content of ['{}','items:\n  - one\n  - two','a: &a 1\nb: *a','a: 1\n---\nb: 2'])assert.doesNotThrow(()=>validate(content,'yaml'))
  assert.deepEqual(diagnose('arbitrary content','text'),[])
})

test('Host blocks scalar YAML at both preview and write for human and AI',async()=>{
  const service=new NacosService(),connection={id:'c',generation:'g',name:'n',dialect:'nacos',environment:'sit',live:true}
  const input={namespaceId:'',group:'G',dataId:'bad.yaml',kind:'create',content:'222\nkkk',type:'yaml'}
  let writes=0
  const send=async action=>{if(action==='nacos-config')throw Object.assign(new Error('missing'),{category:'not-found'});writes++;return {}}
  for(const actor of ['user','ai'])for(const action of ['nacos-preview','nacos-write'])await assert.rejects(service.request('owner',connection,action,input,actor,send,()=>{}),/顶层键值对象/)
  assert.equal(writes,0)
})

test('six format definitions normalize aliases and preserve explicit remote/unknown types',()=>{
  assert.deepEqual(NACOS_CONFIG_TYPES.map(item=>item.type),['yaml','json','properties','xml','html','text'])
  assert.equal(normalizeNacosConfigType('YML'),'yaml')
  assert.equal(resolveNacosConfigType('text','app.xml'),'text')
  assert.equal(resolveNacosConfigType(undefined,'app.HTML'),'html')
  assert.equal(resolveNacosConfigType('customType','app.yaml'),'customType')
  assert.match(nacosConfigValidationNote('customType'),/未校验/)
  assert.match(nacosConfigValidationNote('text'),/不进行格式校验/)
})

test('XML validates one root, tags, attributes and entities while allowing namespace, CDATA and inert DOCTYPE',()=>{
  for(const content of ['<?xml version="1.0"?><root xmlns:n="urn:test"><n:item a="1"><![CDATA[a < b]]></n:item><!--ok--></root>','<!DOCTYPE root SYSTEM "https://invalid.example/unfetched"><root/>','<root value="&amp;&#65;&#x42;"/>'])assert.deepEqual(diagnose(content,'xml'),[])
  for(const content of ['','plain','<a/><b/>','<a><b></a>','<a x=bad/>','<a x="1" x="2"/>','<a>&missing;</a>','<a>&#0;</a>','<a x="&#xD800;"/>','<!-- <!ENTITY fake "secret"> --><root>&fake;</root>','<unbound:a/>','<a xmlns:xml="invalid"/>','<a xmlns:x="urn:same" xmlns:y="urn:same" x:p="1" y:p="2"/>'])assert.ok(diagnose(content,'xml').length,content)
  const issues=diagnose('<root>\r\n<a x="secret" x="secret"/>\r\n</root>','xml')
  assert.equal(issues[0].line,2);assert.equal(JSON.stringify(issues).includes('secret'),false)
})

test('HTML validates document and fragments with void elements and optional closing tags',()=>{
  for(const content of ['<!DOCTYPE html><html><head><title>test</title></head><body><input disabled><br><p>one<p>two</body></html>','<ul><li>one<li>two</ul>','<div title="&amp;">ok</div>','plain HTML text'])assert.deepEqual(diagnose(content,'html'),[])
  for(const content of ['<div a="1" a="2">text</div>','<div a="secret','<!-- unclosed','<p>&nonexistent;</p>'])assert.ok(diagnose(content,'html').length,content)
})

test('Properties invalid Unicode is checked even when the file ends in a continuation',()=>{
  for(const ending of ['\n','\r\n','\r'])assert.throws(()=>validate('x=\\uBAD\\'+ending,'properties'),/Unicode/)
  assert.doesNotThrow(()=>validate('x=valid\\\n','properties'))
})

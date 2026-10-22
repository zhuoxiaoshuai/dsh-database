import test from 'node:test'
import assert from 'node:assert/strict'
import {protectedConfig,applyPublicEdits,aiProjection} from '../src/host/data-sources/nacos/config-protection.mjs'
import {NacosService} from '../src/host/nacos-service.ts'
import {ConfigurationService} from '../src/host/data-sources/nacos/configuration-service.mjs'

test('XML model view protects direct, indirect, encoded, CDATA and comment credentials while exact public edits preserve bytes',()=>{
  const sources=[
    '<config><password>keep-private</password><port>80</port></config>',
    '<config><property name="pass&#119;ord" value="keep-private"/><port>80</port></config>',
    '<config><entry key="token">keep-private</entry><port>80</port></config>',
    '<config><value><![CDATA[Bearer keep-private]]></value><port>80</port></config>',
    '<config><value>&#66;earer keep-private</value><port>80</port></config>',
    '<config><!--password: keep-private--><port>80</port></config>',
  ]
  for(const source of sources){
    const model=protectedConfig(source,'xml');assert.equal(model.safe,true);assert.equal(model.text.includes('keep-private'),false)
    assert.equal(applyPublicEdits(source,'xml',[{oldText:'80',newText:'81'}]),source.replace('80','81'))
    assert.throws(()=>applyPublicEdits(source,'xml',[{oldText:'keep-private',newText:'changed'}]),/人工编辑/)
    assert.throws(()=>applyPublicEdits(source,'xml',[{oldText:'<port>80</port>',newText:'<token>80</token>'}]),/人工编辑/)
    assert.equal(JSON.stringify(aiProjection({content:source,type:'xml'})).includes('keep-private'),false)
  }
})

test('HTML model views protect attributes, indirect names, entity encoding, comments and opaque script/template source',()=>{
  const sources=[
    '<input name="password" value="keep-private"><p>80</p>',
    '<meta name="to&#107;en" content="keep-private"><p>80</p>',
    '<div password="keep-private"></div><p>80</p>',
    '<div title="&#66;earer keep-private"></div><p>80</p>',
    '<!-- token: keep-private --><p>80</p>',
    '<script>keep-private</script><p>80</p>',
    '<style>/* keep-private */</style><p>80</p>',
    '<button onclick="keep-private">go</button><p>80</p>',
    '<p>{{ keep-private }}</p><p>80</p>',
    '<template><span>keep-private</span></template><p>80</p>',
    '<iframe srcdoc="keep-private"></iframe><p>80</p>',
    '<div data-config="{&quot;password&quot;:&quot;keep-private&quot;}"></div><p>80</p>',
    '<!DOCTYPE html><html><head><meta name="token" content="keep-private"></head><body><p>80</p></body></html>',
  ]
  for(const source of sources){
    const view=protectedConfig(source,'html');assert.equal(view.safe,true,source);assert.equal(view.text.includes('keep-private'),false,source)
    assert.equal(applyPublicEdits(source,'html',[{oldText:'80',newText:'81'}]),source.replace('80','81'))
    assert.throws(()=>applyPublicEdits(source,'html',[{oldText:'keep-private',newText:'changed'}]),/人工编辑/)
  }
})

test('malformed, DTD/entity and ambiguously repaired markup fail closed, while legal optional endings remain editable',()=>{
  for(const [type,source] of [['xml','<!DOCTYPE root [<!ENTITY a "keep-private">]><root>&a;</root>'],['xml','<root>&unknown;</root>'],['html','<table>keep-private<tr><td>80</td></tr></table>'],['html','<div><span>80'],['html','<div password="keep-private" password="other">80</div>']]){
    assert.equal(protectedConfig(source,type).safe,false,source)
    assert.throws(()=>applyPublicEdits(source,type,[{oldText:'80',newText:'81'}]),/人工编辑/)
    assert.equal(JSON.stringify(aiProjection({type,content:source})).includes('keep-private'),false)
  }
  const optional='<ul><li>80<li>90</ul>'
  assert.equal(applyPublicEdits(optional,'html',[{oldText:'80',newText:'81'}]),optional.replace('80','81'))
})

test('Host XML/HTML SIT preview and write redact secrets and preserve originals; UAT/PVT and credential/opaque creates rejected',async()=>{
  for(const type of ['xml','html']){
    const service=new NacosService(),connection={id:'c',generation:'g',name:'n',dialect:'nacos',environment:'sit',live:true}
    let content=type==='xml'?'<root><password>keep-private</password><port>80</port></root>':'<input name="password" value="keep-private"><p>80</p>'
    let writes=0
    const send=async(action,input)=>{
      if(action==='nacos-config')return {content,type,md5:'m'}
      assert.equal(input.content,content.replace('80','81'));content=input.content;writes++;return {saved:true}
    }
    const change={namespaceId:'',group:'G',dataId:'app.'+type,kind:'update',type,expectedMd5:'m',edits:[{oldText:'80',newText:'81'}]}
    const preview=await service.request('owner',connection,'nacos-preview',change,'ai',send,()=>{})
    assert.equal(JSON.stringify(preview).includes('keep-private'),false)
    await service.request('owner',connection,'nacos-write',{...change,previewToken:preview.previewToken},'ai',send,()=>{})
    assert.equal(writes,1);assert.ok(content.includes('keep-private'))
    for(const environment of ['uat','pvt'])await assert.rejects(service.request('owner',{...connection,environment},'nacos-preview',change,'ai',send,()=>{}),/SIT/)
    const absent=async()=>{throw Object.assign(new Error('missing'),{category:'not-found'})}
    const creation={...change,kind:'create',content}
    await assert.rejects(service.request('owner',connection,'nacos-preview',creation,'ai',absent,()=>{}),/敏感凭据/)
    if(type==='html')await assert.rejects(service.request('owner',connection,'nacos-preview',{...creation,content:'<script>ordinary code</script>'},'ai',absent,()=>{}),/敏感凭据/)
    const safeCreate={...creation,content:type==='xml'?'<root port="80"/>':'<p>80</p>'}
    assert.ok((await service.request('owner',connection,'nacos-preview',safeCreate,'ai',absent,()=>{})).previewToken)
  }
})

test('configuration and history retain server types, otherwise infer all six supported extensions',async()=>{
  const service=new ConfigurationService({request:async()=>({content:'test',md5:'m',type:'text'})})
  const target={namespaceId:'',group:'G',dataId:'app.xml'}
  assert.equal((await service.read('nacos-config',target)).type,'text')
  service.client.request=async()=>({content:'test',md5:'m'})
  assert.equal((await service.read('nacos-history',{...target,historyId:'1'})).type,'xml')
  assert.equal((await service.read('nacos-config',{...target,dataId:'app.html'})).type,'html')
})

import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {join} from 'node:path'

/** Dedicated 2.4.3 fixture only; the installed plugin uses real authenticated Host routes. */
export async function installedNacos(page,sessionId,run){
 const port=Number(process.env.NACOS_TEST_PORT);if(!port)throw Error('NACOS_TEST_PORT is required for a dedicated test container')
 const namespace='dsh-installed-'+randomUUID(),base=`http://127.0.0.1:${port}/nacos`;let token='',stage='Nacos fixture setup'
 const target={namespaceId:namespace,group:'G',dataId:'installed.yaml'}
 async function remote(path,method='GET',params={}){const url=new URL(base+path);if(token)url.searchParams.set('accessToken',token);if(method==='GET'||method==='DELETE')for(const[k,v]of Object.entries(params))url.searchParams.set(k,v)
 const res=await fetch(url,{method,headers:{'content-type':'application/x-www-form-urlencoded'},body:['GET','DELETE'].includes(method)?undefined:new URLSearchParams(params)});assert.ok(res.ok,'dedicated fixture request failed');const text=await res.text();try{return JSON.parse(text)}catch{return text}}
 const api=body=>page.evaluate(async({sessionId,body})=>{const response=await fetch('/plugins/database/connections?conversationId='+encodeURIComponent(sessionId),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()}},{sessionId,body})
 try{
 token=(await remote('/v1/auth/login','POST',{username:'nacos',password:'nacos'})).accessToken
 await remote('/v1/console/namespaces','POST',{customNamespaceId:namespace,namespaceName:namespace})
 stage='installed Nacos connection form'
 const empty=page.getByRole('button',{name:'添加连接',exact:true});if(await empty.isVisible())await empty.click();else await page.getByRole('button',{name:'新建连接',exact:true}).click()
 const form=page.getByRole('dialog',{name:'新建数据库连接'});await form.locator('.db-connection-pick-card').filter({hasText:'Nacos'}).click()
 await form.getByLabel('主机地址',{exact:true}).fill('127.0.0.1');await form.getByLabel('端口',{exact:true}).fill(String(port));await form.getByLabel('命名空间 · 可选',{exact:true}).fill(namespace)
 await form.getByLabel('用户名 · 可选',{exact:true}).fill('nacos');await form.getByLabel('密码 · 可选',{exact:true}).fill('nacos');await form.getByLabel('记住密码',{exact:true}).uncheck()
 await form.getByRole('button',{name:'测试连接',exact:true}).click();await form.getByText(/连接测试成功/).waitFor();await form.getByRole('button',{name:'连接',exact:true}).click()
 const workspace=page.getByLabel('Nacos 工作区',{exact:true});await workspace.waitFor();await workspace.getByRole('combobox',{name:'Namespace',exact:true}).selectOption(namespace)
 stage='installed Nacos create preview and confirmation'
 await workspace.getByRole('button',{name:'新增配置',exact:true}).click();const create=page.getByRole('dialog',{name:'新增配置',exact:true});await create.getByLabel('Group',{exact:true}).fill('G');await create.getByLabel('Data ID',{exact:true}).fill(target.dataId);await create.getByRole('button',{name:'创建草稿'}).click()
 const editor=workspace.getByLabel('Nacos 配置正文',{exact:true});await editor.fill('port: 80');await workspace.getByRole('button',{name:'预览发布',exact:true}).click();await page.getByRole('dialog',{name:'确认配置变更',exact:true}).getByRole('button',{name:'确认发布',exact:true}).click();await workspace.getByText(/MD5 (?!新配置)/).waitFor()
 stage='installed Nacos update, history and listeners'
 await editor.fill('port: 81');await workspace.getByRole('button',{name:'预览发布',exact:true}).click();await page.getByRole('dialog',{name:'确认配置变更',exact:true}).getByRole('button',{name:'确认发布',exact:true}).click();await page.getByRole('dialog',{name:'确认配置变更',exact:true}).waitFor({state:'hidden'})
 await workspace.getByRole('tab',{name:'总览',exact:true}).click();await workspace.getByRole('textbox',{name:'Group',exact:true}).fill('G');await workspace.getByRole('textbox',{name:'资源名称',exact:true}).fill('installed');await workspace.getByRole('button',{name:'搜索',exact:true}).click();await workspace.getByRole('button',{name:'历史',exact:true}).click();await workspace.getByRole('columnheader',{name:'版本',exact:true}).waitFor()
 await workspace.getByRole('tab',{name:'总览',exact:true}).click();await workspace.getByRole('button',{name:'监听者',exact:true}).click();await workspace.getByText(/监听状态是采样结果/).waitFor()
 const listed=await page.evaluate(async sessionId=>(await fetch('/plugins/database/connections?conversationId='+encodeURIComponent(sessionId))).json(),sessionId),connection=listed.connections.find(c=>c.dialect==='nacos');assert.ok(connection)
 const body={action:'nacos-request',id:connection.id,generation:connection.generation,input:{operation:'nacos-config',...target}}
 assert.equal((await api({...body,input:{...body.input,actor:'ai'}})).status,400)
 assert.equal((await api({...body,generation:'old'})).status,400)
 const read=await api(body);assert.equal(read.status,200);assert.equal(read.body.content,'port: 81')
 stage='installed Nacos confirmed delete'
 await workspace.getByRole('tab',{name:'installed.yaml · 配置',exact:true}).click();await workspace.getByRole('button',{name:'预览删除',exact:true}).click();await page.getByRole('dialog',{name:'确认配置变更',exact:true}).getByRole('button',{name:'确认删除',exact:true}).click();await workspace.getByText('配置已删除。',{exact:true}).waitFor()
 await page.screenshot({path:join(run,'nacos-installed.png')})
 return 'Nacos 2.4.3 installed plugin: test/connect, create/update preview-confirm, history, listener sampling, trusted HTTP identity/generation, read and delete'
 }catch(error){error.acceptanceStage=stage;throw error}
 finally{if(token){await remote('/v2/cs/config','DELETE',target).catch(()=>{});await remote('/v1/console/namespaces','DELETE',{namespaceId:namespace}).catch(()=>{})}}
}

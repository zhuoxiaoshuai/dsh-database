import {Pagination} from '../workspace/parts/layout/pagination.tsx'
import {useWorkbenchConfirm} from '../workspace/parts/overlay/confirm.tsx'
import { RefreshCw } from 'lucide-react'
import { ActionMenu, ResourceHelp } from '../workspace/parts/overlay/action-menu.tsx'
import {diagnoseNacosConfigFormat, validateNacosConfigFormat} from '../../shared/nacos-config-format.mjs'
import {NACOS_CONFIG_TYPES,resolveNacosConfigType,isSupportedNacosConfigType,nacosConfigValidationNote} from '../../shared/nacos-config-types.mjs'
import {SearchTreeNode} from '../workspace/tree/search-tree.tsx'
import {CatalogRootNode} from '../workspace/shell/catalog-root-node.tsx'
import {DbTable} from '../workspace/parts/layout/db-table.tsx'
import React, {useCallback, useEffect, useRef, useState} from 'react'
import type {Connection, WorkspaceBridge} from '../../shared/workbench.ts'
import type {WorkspaceSourceContext} from '../workspace-sources.tsx'
import type {StandardSourceBindings} from '../data-sources/types.ts'
import {createRequestScope} from '../workspace/parts/request-scope.ts'
import {ResourceError, ResourceList, ResourceHeading, ResourceMetadata} from '../workspace/parts/layout/resource-list.tsx'
import {DialogFrame} from '../workspace/parts/overlay/dialog-frame.tsx'
import {useNavigationGuard} from '../workspace/parts/navigation-guard.ts'
import {ConfigEditor, ConfigDiff} from './config-editor.tsx'
import {AiQueryFrame} from '../ai-executions.tsx'

type Target = {namespaceId: string; group: string; dataId?: string; serviceName?: string}
type Page = Target & {id: string; kind: 'home' | 'config' | 'history' | 'listeners' | 'service' | 'activity'; create?: boolean}
const pageLabels={home:'总览',config:'配置',history:'历史',listeners:'监听者',service:'服务详情',activity:'操作记录'}
const api = (bridge: WorkspaceBridge, connection: Connection, operation: string, input: object, signal?: AbortSignal): Promise<any> => {
  if (!connection.live || !bridge.sourceRequest) return Promise.reject(new Error('请先连接 Nacos。'))
  return bridge.sourceRequest(connection,'nacos-request',{operation,...input},signal)
}
function useRead(bridge: WorkspaceBridge, connection: Connection, operation: string, input: object, enabled = true) {
  const identity = JSON.stringify([connection.id,connection.generation,connection.live,operation,input]), scope = useRef(createRequestScope(identity))
  const active=useRef(identity);active.current=identity
  const isCurrent=(ticket:Parameters<typeof scope.current.isCurrent>[0])=>active.current===identity&&scope.current.isCurrent(ticket)
  const [value,setValue] = useState<any>(), [error,setError] = useState(''), [busy,setBusy] = useState(false), [refresh,setRefresh] = useState(0)
  useEffect(() => {
    scope.current.invalidate(identity); if (!enabled) {setValue(undefined);setBusy(false);return}
    const ticket = scope.current.latest('read')
    setBusy(true); setError(''); setValue(undefined)
    void api(bridge,connection,operation,input,ticket.signal).then(v => {if (isCurrent(ticket)) setValue(v)})
      .catch(e => {if (isCurrent(ticket)) setError(e.message)})
      .finally(() => {if (isCurrent(ticket)) setBusy(false); scope.current.finish(ticket)})
    return () => scope.current.cancel(ticket)
  },[bridge,identity,refresh,enabled])
  return {value,error,busy,reload:() => setRefresh(v => v+1)}
}

export function NacosTree({bridge,connection,onSelect,selectedId,refreshToken=0}: {bridge:WorkspaceBridge;connection:Connection;onSelect(id:string):void;selectedId?:string;refreshToken?:number}) {
  const read = useRead(bridge,connection,'nacos-namespaces',{refreshToken})
  const namespaces = read.value?.items || []
  const activeId=selectedId===undefined ? undefined : selectedId || JSON.stringify({namespaceId:connection.database || '',feature:'config'})
  return <div className="db-nacos-tree">{read.error && <p role="alert">{read.error}<button onClick={read.reload}>重试</button></p>}{read.busy && <p>正在读取 Namespace…</p>}
    {namespaces.slice(0,200).map((n:any) => <SearchTreeNode key={n.namespace || 'public'} folder text={n.namespaceShowName || n.namespace || 'public'}>{['config','naming'].map(feature => <CatalogRootNode key={feature} label={feature==='config'?'配置管理':'服务发现'} selected={activeId===JSON.stringify({namespaceId:n.namespace || '',feature})} onSelect={() => onSelect(JSON.stringify({namespaceId:n.namespace || '',feature}))}/>)}</SearchTreeNode>)}
    {namespaces.length>200 && <p>仅展示前 200 个 Namespace；右侧可选择其他 Namespace。</p>}
  </div>
}
function Overview({bridge,connection,root,onScope,open,openConfig}: {bridge:WorkspaceBridge;connection:Connection;root:string;onScope(root:string):void;open(page:Page):void;openConfig(page:Page):void}) {
  let chosen:any = {}; try {chosen=JSON.parse(root)} catch {}
  const [namespaceSearch,setNamespaceSearch]=useState('')
  const namespaceId=chosen.namespaceId ?? connection.database ?? '',feature=chosen.feature || 'config'
  const setNamespace=(value:string)=>onScope(JSON.stringify({namespaceId:value,feature}))
  const setFeature=(value:string)=>onScope(JSON.stringify({namespaceId,feature:value}))
  const [group,setGroup] = useState(''),[search,setSearch] = useState(''),[query,setQuery] = useState({group:'',search:''}),[page,setPage] = useState(1),[adding,setAdding] = useState(false),[newId,setNewId] = useState(''),[newGroup,setNewGroup] = useState('DEFAULT_GROUP')
  useEffect(() => {setPage(1)},[root])
  const namespaces=useRead(bridge,connection,'nacos-namespaces',{})
  const allNamespaces=namespaces.value?.items || [{namespace:'',namespaceShowName:'public'}]
  const selectedNamespace=allNamespaces.find((n:any)=>(n.namespace || '')===namespaceId)
  const namespaceOptions=[...(selectedNamespace?[selectedNamespace]:[]),...allNamespaces.filter((n:any)=>(n.namespace || '')!==namespaceId&&JSON.stringify([n.namespace,n.namespaceShowName]).toLowerCase().includes(namespaceSearch.toLowerCase())).slice(0,199)]
  const read=useRead(bridge,connection,feature==='config'?'nacos-configs':'nacos-services',{namespaceId,group:query.group,...(feature==='config'?{dataId:query.search}:{serviceName:query.search}),pageNo:page,pageSize:50})
  const rows=read.value?.items || []
  const select = (row:any,kind:Page['kind']) => {
    const group=row.group || row.groupName || 'DEFAULT_GROUP'
    const target={namespaceId,group,dataId:row.dataId,serviceName:row.name || row.serviceName}
    if (kind==='config'||kind==='history'||kind==='listeners') openConfig({...target,kind,id:JSON.stringify([namespaceId,group,target.dataId])})
    else open({...target,kind,id:JSON.stringify([namespaceId,group,target.serviceName,'service'])})
  }
  const title=feature==='config'?'配置管理':'服务发现'
  return <ResourceList className="db-resource-list db-nacos-overview" title={title} bodyClassName="db-resource-body" loading={read.busy} error={read.error || namespaces.error}
    header={<><ResourceHeading title={title} actions={<><button className="db-icon-button" aria-label="刷新" title="刷新" onClick={read.reload}><RefreshCw size={14}/></button>{feature==='config'&&<button className="db-primary" onClick={()=>setAdding(true)}>新增配置</button>}<button className="db-text-button" onClick={()=>open({id:'activity',kind:'activity',namespaceId:'',group:''})}>操作记录</button></>}/><form className="db-resource-filters" onSubmit={e=>{e.preventDefault();setQuery({group,search});setPage(1);read.reload()}}><details className="db-namespace-filter"><summary>筛选 Namespace</summary><input aria-label="筛选 Namespace" placeholder="Namespace 名称" value={namespaceSearch} onChange={e=>setNamespaceSearch(e.target.value)}/></details><select aria-label="Namespace" value={namespaceId} onChange={e=>{setNamespace(e.target.value);setPage(1)}}>{namespaceOptions.map((n:any)=><option key={n.namespace || ''} value={n.namespace || ''}>{n.namespaceShowName || n.namespace || 'public'}</option>)}</select>
      <select aria-label="功能" value={feature} onChange={e=>{setFeature(e.target.value);setPage(1)}}><option value="config">配置管理</option><option value="naming">服务发现</option></select>
      <input aria-label="Group" placeholder="Group" value={group} onChange={e=>setGroup(e.target.value)}/><input aria-label="资源名称" placeholder={feature==='config'?'Data ID':'服务名'} value={search} onChange={e=>setSearch(e.target.value)}/>
      <button className="db-btn" type="submit">搜索</button></form></>}
    paging={<Pagination pageSize={50} page={page} total={read.value?.total} onPage={setPage}/>}>
    <DbTable rows={rows} rowKey={(row:any,i)=>JSON.stringify([row.group,row.dataId,row.name,i])} loading={read.busy} columns={[
      {key:'name',title:feature==='config'?'Data ID':'服务名',render:(row:any)=>row.dataId || row.name || row.serviceName},
      {key:'group',title:'Group',render:(row:any)=>row.group || row.groupName},
      {key:'actions',title:'操作',render:(row:any)=>feature==='config'?<><button className="db-text-button" onClick={()=>select(row,'config')}>编辑</button><button className="db-text-button" onClick={()=>select(row,'history')}>历史</button><button className="db-text-button" onClick={()=>select(row,'listeners')}>监听者</button></>:<button className="db-text-button" onClick={()=>select(row,'service')}>详情</button>}
    ]}/>

    {adding&&<DialogFrame title="新增配置" close={()=>setAdding(false)} footer={<button className="db-primary" disabled={!newId||!newGroup} onClick={()=>{openConfig({id:JSON.stringify([namespaceId,newGroup,newId]),kind:'config',namespaceId,group:newGroup,dataId:newId,create:true});setAdding(false)}}>创建草稿</button>}><div className="db-resource-form"><label>Group<input value={newGroup} onChange={e=>setNewGroup(e.target.value)}/></label><label>Data ID<input value={newId} onChange={e=>setNewId(e.target.value)}/></label></div></DialogFrame>}
  </ResourceList>
}
function ConfigPage({bridge,connection,page,owner,onDirty,onDeleted}: {bridge:WorkspaceBridge;connection:Connection;page:Page;owner:string;onDirty(dirty:boolean):void;onDeleted():void}) {
  const [baseline,setBaseline]=useState<any>(),[text,setText]=useState(''),[type,setType]=useState('yaml'),[error,setError]=useState(''),[busy,setBusy]=useState(false),[preview,setPreview]=useState<any>(),[unknown,setUnknown]=useState(false),[creating,setCreating]=useState(!!page.create),[deleted,setDeleted]=useState(false)
  const dirty=creating ? !!text : !!baseline && (text!==baseline.content || type!==(baseline.type || 'text'))
  const [focusEditor,setFocusEditor]=useState(0)
  const closePreview=()=>{setPreview(undefined);setFocusEditor(value=>value+1)}
  const current=useRef({dirty,text,creating});current.current={dirty,text,creating}
  const scopeIdentity=JSON.stringify([connection.id,connection.generation,connection.live])
  const activeScope=useRef(scopeIdentity);activeScope.current=scopeIdentity
  const requestScope=useRef(createRequestScope(scopeIdentity))
  const isCurrent=(ticket:Parameters<typeof requestScope.current.isCurrent>[0])=>activeScope.current===scopeIdentity&&requestScope.current.isCurrent(ticket)
  const {confirm,confirmation}=useWorkbenchConfirm()
  const confirmLeave=useCallback(()=>confirm({title:'放弃配置修改',body:'配置有未保存更改，确定离开？',confirmLabel:'放弃修改'}),[confirm])
  useNavigationGuard(owner,JSON.stringify([connection.id,page.id]),dirty,confirmLeave)
  useEffect(()=>{onDirty(dirty)},[dirty,onDirty])
  const load=async (discard = false) => {
    const ticket=requestScope.current.latest('config');setBusy(true);setError('')
    try {const value=await api(bridge,connection,'nacos-config',page,ticket.signal);if (!isCurrent(ticket)) return
      if (current.current.dirty && !discard) {setError('当前有未保存更改，已保留草稿。请通过差异核对远端版本。');setPreview({before:value.content,after:current.current.text,conflict:true})}
      else {const configType=resolveNacosConfigType(value.type,page.dataId);setBaseline({...value,type:configType});setText(value.content);setType(configType);setUnknown(false);setDeleted(false);setCreating(false)}
    } catch(e) {if(isCurrent(ticket)) setError((e as Error).message)} finally {if(isCurrent(ticket))setBusy(false);requestScope.current.finish(ticket)}
  }
  useEffect(()=>{requestScope.current.invalidate(scopeIdentity);setPreview(undefined);setBusy(false);if(connection.live&&!current.current.creating)void load();return()=>requestScope.current.invalidate('closed')},[connection.id,connection.generation,connection.live])
  const prepare=async(kind:string)=>{
    const ticket=requestScope.current.latest('change');setBusy(true);setError('')
    try {
      const change={...page,kind,content:text,type,expectedMd5:baseline?.md5}
      const issues=kind==='delete'?[]:diagnoseNacosConfigFormat(text,type)
      if(issues.length){setPreview({kind,before:baseline?.content||'',after:text,type,issues,change,scopeIdentity});return}
      const value=await api(bridge,connection,'nacos-preview',change,ticket.signal)
      if(isCurrent(ticket))setPreview({...value,type,issues,change,scopeIdentity})
    }
    catch(e){if(isCurrent(ticket))setError((e as Error).message)}
    finally{if(isCurrent(ticket))setBusy(false);requestScope.current.finish(ticket)}
  }
  const submit=async()=>{
    if(!preview?.previewToken||preview.issues?.length||!connection.live||preview.scopeIdentity!==scopeIdentity)return
    const ticket=requestScope.current.latest('change');const change=preview;setBusy(true);setError('')
    try{
      if(change.kind!=='delete')validateNacosConfigFormat(change.change.content,change.change.type)
      const result=await api(bridge,connection,'nacos-write',{...change.change,previewToken:change.previewToken},ticket.signal)
      if(!isCurrent(ticket))return
      if(result.executionStatus && result.executionStatus!=='succeeded'){setUnknown(true);throw new Error('配置结果未知，请读取核对，勿重试。')}
      setPreview(undefined)
      if(change.kind==='delete'){setBaseline(undefined);setText('');setDeleted(true);onDeleted()}
      else{setCreating(false);current.current.dirty=false;await load(true)}
    }catch(e){if(isCurrent(ticket)){if((e as any).executionStatus==='unknown'||(e as any).effect==='unknown')setUnknown(true);setError((e as Error).message)}}
    finally{if(isCurrent(ticket))setBusy(false);requestScope.current.finish(ticket)}
  }
  return <section className="db-nacos-config">
    {confirmation}
    <ResourceHeading title={page.dataId} summary={<span className={`db-resource-badge ${unknown||dirty?'is-warning':''}`}>{deleted?'已删除':unknown?'待核对':dirty?'未保存':creating?'新草稿':'已同步'}</span>}
      actions={<><button className="db-primary" disabled={busy||unknown||deleted||!connection.live||(!creating&&!baseline)} onClick={()=>void prepare(creating?'create':'update')}>{busy?'处理中…':'预览发布'}</button>
        <ActionMenu label="更多配置操作">{baseline&&<button role="menuitem" className="db-stop" disabled={busy||unknown||deleted||!connection.live} onClick={()=>void prepare('delete')}>预览删除</button>}<button role="menuitem" disabled={busy||!connection.live} onClick={()=>void load()}>刷新核对</button></ActionMenu></>}/>
    <ResourceMetadata items={[{label:'Namespace',value:page.namespaceId || 'public'},{label:'Group',value:page.group}]}/>
    <div className="db-resource-filters db-config-toolbar"><label className="db-resource-inline-field">格式<select aria-label="配置格式" value={type} disabled={busy} onChange={e=>setType(e.target.value)}>{!isSupportedNacosConfigType(type)&&<option value={type}>{type}（未校验）</option>}{NACOS_CONFIG_TYPES.map(item=><option key={item.type} value={item.type}>{item.label}</option>)}</select></label>
      <button className="db-icon-button" aria-label="刷新核对" title="刷新核对" disabled={busy||!connection.live} onClick={()=>void load()}><RefreshCw size={14}/></button>
      <details className="db-resource-inline-details"><summary>详情</summary><span className="db-mono">MD5：{baseline?.md5 || '尚未发布'}</span></details>
    </div>
    {nacosConfigValidationNote(type)&&<p className="db-info-note">{nacosConfigValidationNote(type)}</p>}

    {error&&<ResourceError message={error}/>} {unknown&&<p className="db-info-note">结果需核对，已禁止重新提交。确认远端内容后可丢弃草稿并重新读取。</p>}
    {unknown&&<button className="db-text-button" onClick={()=>{void load(true)}}>丢弃草稿并读取</button>}
    <ConfigEditor value={text} type={type} onChange={setText} focusRequest={focusEditor} readOnly={busy||unknown||deleted}/>
    {preview&&<DialogFrame title={preview.conflict?'远端与草稿差异':'确认配置变更'} busy={busy} size="wide" close={closePreview} footer={<><button className="db-text-button" disabled={busy} onClick={closePreview}>{preview.issues?.length?'返回修改':'取消'}</button>{preview.conflict&&<button className="db-text-button" disabled={busy} onClick={()=>{closePreview();void load(true)}}>丢弃草稿并读取</button>}{!preview.conflict&&<button className="db-primary" disabled={busy||unknown||!connection.live||preview.scopeIdentity!==scopeIdentity||!!preview.issues?.length||!preview.previewToken} onClick={()=>void submit()}>确认{preview.kind==='delete'?'删除':'发布'}</button>}</>}><p className="db-config-preview-target">{page.namespaceId || 'public'} / {page.group} / {page.dataId}</p>{!!preview.issues?.length&&<p className="db-info-note">草稿格式检查；尚未核对远端版本。</p>}<ConfigDiff before={preview.before} after={preview.after} type={preview.kind==='delete'?'text':preview.type||type} issues={preview.issues} autoFocus/></DialogFrame>}
  </section>
}
function DetailPage({bridge,connection,page}: {bridge:WorkspaceBridge;connection:Connection;page:Page}) {
  const [pageNo,setPage]=useState(1),[historyId,setHistory]=useState(''),[cluster,setCluster]=useState('DEFAULT'),[showDiff,setDiff]=useState(false)
  const operation=page.kind==='history'?'nacos-history':page.kind==='listeners'?'nacos-listeners':'nacos-service'
  const read=useRead(bridge,connection,operation,{...page,pageNo,pageSize:50,...(historyId?{historyId}:{})})
  useEffect(()=>{if(page.kind==='service'&&read.value?.clusters?.length&&!read.value.clusters.some((c:any)=>c.name===cluster)){setCluster(read.value.clusters[0].name);setPage(1)}},[read.value,cluster,page.kind])
  const instances=useRead(bridge,connection,page.kind==='service'?'nacos-instances':'nacos-config',{...page,clusterName:cluster,pageNo,pageSize:50},(page.kind==='service'&&!!read.value&&(read.value.clusters?.length ? read.value.clusters.some((c:any)=>c.name===cluster) : true))||(page.kind==='history'&&showDiff))
  const value=read.value
  const listenerEntries=Object.entries(value?.listeners?.lisentersGroupkeyStatus || {}).slice(0,200).map(([client,status])=>({client,md5:typeof status==='string'?status:JSON.stringify(status)}))
  return <ResourceList title={`${page.group}/${page.dataId||page.serviceName} · ${pageLabels[page.kind]}`} bodyClassName="db-resource-body" header={<><ResourceHeading title={page.dataId||page.serviceName} summary={pageLabels[page.kind]} actions={<button className="db-text-button" onClick={()=>{read.reload();instances.reload()}}>刷新</button>}/><ResourceMetadata items={[{label:'Namespace',value:page.namespaceId || 'public'},{label:'Group',value:page.group}]}/></>} loading={read.busy} error={read.error || instances.error} paging={page.kind==='history'&&!historyId?<Pagination pageSize={50} page={pageNo} total={value?.total} onPage={setPage}/>:undefined}>
    {page.kind==='history'&&<>{historyId?<><div className="db-resource-actions"><button className="db-text-button" onClick={()=>{setHistory('');setDiff(false)}}>返回历史列表</button><button className="db-text-button" onClick={()=>setDiff(v=>!v)}>与当前配置 Diff</button></div>{showDiff&&instances.value?<ConfigDiff before={value?.content||''} after={instances.value.content} type={value?.type||instances.value.type||'text'}/>:<ConfigEditor key={historyId} value={value?.content||''} type={value?.type||'text'} readOnly onChange={()=>{}}/>}</>:<DbTable rows={value?.items || []} rowKey={(row:any)=>String(row.id)} columns={[{key:'id',title:'版本',render:(row:any)=><button className="db-text-button" onClick={()=>setHistory(String(row.id))}>{row.id}</button>},{key:'lastModifiedTime',title:'修改时间'},{key:'srcUser',title:'操作者'},{key:'md5',title:'MD5'}]}/>}</>}
    {page.kind==='listeners'&&<><div className="db-resource-actions"><span className="db-resource-summary">采样状态：{value?.listeners?.collectStatus ?? '未知'}</span><ResourceHelp label="监听采样说明">监听状态是采样结果；空列表不代表配置未生效。</ResourceHelp></div><DbTable rows={listenerEntries} rowKey={row=>row.client} columns={[{key:'client',title:'客户端'},{key:'md5',title:'报告 MD5 / 状态'}]}/>{Object.keys(value?.listeners?.lisentersGroupkeyStatus || {}).length>200&&<p>仅展示前 200 个监听者；接口没有远端分页。</p>}</>}
    {page.kind==='service'&&<><div className="db-resource-actions"><ResourceHelp label="健康状态说明">健康状态由注册中心报告，不等同于业务实际可用性。</ResourceHelp><label className="db-resource-inline-field">集群<select aria-label="集群" value={cluster} onChange={e=>{setCluster(e.target.value);setPage(1)}}>{(value?.clusters?.map((c:any)=>c.name)||['DEFAULT']).map((name:string)=><option key={name}>{name}</option>)}</select></label></div><DbTable rows={instances.value?.list || []} rowKey={(i:any)=>`${i.ip}:${i.port}:${i.clusterName}`} loading={instances.busy} columns={[{key:'ip',title:'IP'},{key:'port',title:'端口'},{key:'clusterName',title:'集群'},{key:'healthy',title:'健康',render:(i:any)=><span className={`db-resource-badge ${i.healthy?'is-success':'is-warning'}`}>{i.healthy?'健康':'异常'}</span>},{key:'enabled',title:'启用',render:(i:any)=><span className="db-resource-badge">{i.enabled?'已启用':'已停用'}</span>},{key:'weight',title:'权重'},{key:'metadata',title:'Metadata',render:(i:any)=><pre>{JSON.stringify(i.metadata)}</pre>}]}/><footer className="db-resource-pagination"><Pagination pageSize={50} page={pageNo} total={instances.value?.count} onPage={setPage}/></footer></>}
  </ResourceList>
}
function ConfigResourcePage({bridge,connection,page,owner,onDirty,onDeleted,onKind}: {bridge:WorkspaceBridge;connection:Connection;page:Page;owner:string;onDirty(dirty:boolean):void;onDeleted():void;onKind(kind:'config'|'history'|'listeners'):void}) {
  const [editorMounted,setEditorMounted]=useState(false)
  const showEditor=editorMounted || page.kind==='config'
  if (showEditor && !editorMounted) setEditorMounted(true)
  const view=(kind:'config'|'history'|'listeners',label:string)=><button type="button" className={page.kind===kind?'is-active':''} aria-pressed={page.kind===kind} onClick={()=>onKind(kind)}>{label}</button>
  return <div className="db-nacos-config-resource">
    <div className="db-result-tabs" aria-label="配置视图">{view('config','编辑')}{view('history','历史')}{view('listeners','监听者')}</div>
    {showEditor && <div hidden={page.kind!=='config'}><ConfigPage bridge={bridge} connection={connection} page={{...page,kind:'config'}} owner={owner} onDirty={onDirty} onDeleted={onDeleted}/></div>}
    {page.kind==='history' && <DetailPage bridge={bridge} connection={connection} page={{...page,kind:'history'}}/>}
    {page.kind==='listeners' && <DetailPage bridge={bridge} connection={connection} page={{...page,kind:'listeners'}}/>}
  </div>
}
export function useNacosBindings({host:bridge,connection,navigation,catalogRoot,onCatalogRoot,conversationId}:WorkspaceSourceContext):StandardSourceBindings {
  const {confirm,confirmation}=useWorkbenchConfirm()
  const [dirty,setDirty]=useState<Record<string,boolean>>({})
  const dirtyRef=useRef(dirty);dirtyRef.current=dirty
  const updateDirty=useCallback((id:string,value:boolean)=>setDirty(old=>old[id]===value?old:{...old,[id]:value}),[])
  const open=(page:Page)=>navigation!.open(page)
  const openConfig=(page:Page)=>{
    const id=JSON.stringify([page.namespaceId,page.group,page.dataId])
    navigation!.setTabs(previous=>previous.some(tab=>tab.id===id)
      ? previous.map(tab=>tab.id===id?{...(tab as Page),kind:page.kind,create:(tab as Page).create}:tab)
      : [...previous,{...page,id}])
    navigation!.setActive(id)
  }
  const showConfigView=(id:string,kind:'config'|'history'|'listeners')=>navigation!.setTabs(previous=>previous.map(tab=>tab.id===id?{...(tab as Page),kind}:tab))
  return {sourceName:'Nacos',pages:{initialItems:[{id:'home'}],initialActive:'home',fallback:'home',keepMounted:true,
    taskActions:[{id:'config',label:'配置管理',onOpen:()=>{let root:any={};try{root=JSON.parse(catalogRoot||'{}')}catch{};onCatalogRoot?.(JSON.stringify({namespaceId:root.namespaceId||'',feature:'config'}));navigation!.setActive('home')}},{id:'service',label:'服务发现',onOpen:()=>{let root:any={};try{root=JSON.parse(catalogRoot||'{}')}catch{};onCatalogRoot?.(JSON.stringify({namespaceId:root.namespaceId||'',feature:'naming'}));navigation!.setActive('home')}},{id:'activity',label:'操作记录',onOpen:()=>open({id:'activity',kind:'activity',namespaceId:'',group:''})}],
    beforeClose:item=>!dirtyRef.current[item.id]||confirm({title:'关闭配置',body:'配置有未保存更改，确定关闭？',confirmLabel:'放弃并关闭'}),
    extra:confirmation,
    onClose:item=>setDirty(old=>{const next={...old};delete next[item.id];return next}),
    describe:item=>{const page=item as Page;const label=page.id==='home'?'总览':page.id==='activity'?'操作记录':page.kind==='service'?`${page.serviceName} · ${pageLabels.service}`:page.dataId||page.serviceName;return {id:page.id,label,closable:page.id!=='home',dirty:!!dirty[page.id]}},
    content:item=>{const page=item as Page
      if(page.id==='home')return <Overview bridge={bridge} connection={connection} root={catalogRoot} onScope={root=>onCatalogRoot?.(root)} open={open} openConfig={openConfig}/>
      if(page.kind==='activity')return <AiQueryFrame bridge={bridge} connection={connection}><p>配置变更与 AI 操作记录。正文不保存到执行历史。</p></AiQueryFrame>
      if(page.kind==='service')return <DetailPage bridge={bridge} connection={connection} page={page}/>
      return <ConfigResourcePage bridge={bridge} connection={connection} page={page} owner={conversationId} onDirty={value=>updateDirty(page.id,value)} onDeleted={()=>{dirtyRef.current={...dirtyRef.current,[page.id]:false};updateDirty(page.id,false);void navigation!.close(page.id)}} onKind={kind=>showConfigView(page.id,kind)}/>}
  }}
}

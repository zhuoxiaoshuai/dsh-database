import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction} from 'react'
import {SchemaCache} from '../schema/schema-cache.ts'
import type {Connection, PendingSchemaPick, WorkspaceBridge} from '../../shared/workbench.ts'
import type {TreePaneActions} from '../tree-pane-actions.ts'
import type {TreeFocus} from '../tree-focus.ts'
export function useSqlCatalogController(host: WorkspaceBridge, connection: Connection, connections: Connection[] = [connection]) {
  type Nav={schema:string;treeBusy:boolean;treeFocus?:TreeFocus}
  const seed=useMemo<Nav>(()=>({schema:connection.workbench?.schema || '',treeBusy:false}),[connection.id])
  const [navigation,setNavigation]=useState<Record<string,Nav>>({[connection.id]:seed})
  const {schema,treeBusy,treeFocus}=navigation[connection.id] || seed
  const [cacheTick,setCacheTick]=useState(0)
  const update=useCallback(<K extends keyof Nav>(key:K,value:SetStateAction<Nav[K]>)=>setNavigation(old=>{
    const current=old[connection.id] || seed, next=typeof value==='function'?(value as (old:Nav[K])=>Nav[K])(current[key]):value
    return current[key]===next?old:{...old,[connection.id]:{...current,[key]:next}}
  }),[connection.id,seed])
  const pendingRef=useRef<PendingSchemaPick>(),actionsRef=useRef<TreePaneActions>()
  const catalogRef=useRef(host.catalog);catalogRef.current=host.catalog
  const stableCatalog=useCallback((item:Connection,input:Parameters<NonNullable<WorkspaceBridge['catalog']>>[1],signal?:AbortSignal)=>catalogRef.current!(item,input,signal),[])
  const cache=useMemo(()=>new SchemaCache(stableCatalog),[stableCatalog,host.conversationId])
  useEffect(()=>cache.subscribe(()=>setCacheTick(v=>v+1)),[cache])
  useEffect(()=>()=>cache.cancelPending(),[cache])
  const onSchema=useCallback((value:SetStateAction<string>)=>update('schema',value),[update])
  const onTreeBusy=useCallback((value:SetStateAction<boolean>)=>update('treeBusy',value),[update])
  const onTreeFocus=useCallback((value:SetStateAction<TreeFocus|undefined>)=>update('treeFocus',value),[update])
  const seen=useRef(connections)
  // Invalidate before resource components start their passive-effect requests.
  useLayoutEffect(()=>{
    for(const previous of seen.current)if(!connections.some(next=>next.id===previous.id&&next.generation===previous.generation))cache.invalidateConnection(previous)
    seen.current=connections
    setNavigation(old=>{const entries=Object.entries(old).filter(([id])=>connections.some(c=>c.id===id));return entries.length===Object.keys(old).length?old:Object.fromEntries(entries)})
    if(pendingRef.current&&!connections.some(c=>c.id===pendingRef.current?.connectionId))pendingRef.current=undefined
  },[connections,cache])
  return {cache,cacheTick,schema,treeBusy,treeFocus,pendingRef,actionsRef,onSchema,onTreeBusy,onTreeFocus}
}

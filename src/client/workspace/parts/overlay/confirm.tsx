import React,{useCallback,useEffect,useRef,useState} from 'react'
import {DialogFrame} from './dialog-frame.tsx'
import {Button} from '../controls/button.tsx'
export type ConfirmOptions={title:string;body:React.ReactNode;confirmLabel?:string;danger?:boolean}
/** Confirmation belongs to the component lifecycle. A pending request cannot be submitted twice. */
export function useWorkbenchConfirm(){
  const [options,setOptions]=useState<ConfirmOptions>()
  const pending=useRef<{promise:Promise<boolean>;resolve(value:boolean):void}>()
  const finish=useCallback((value:boolean)=>{const request=pending.current;pending.current=undefined;setOptions(undefined);request?.resolve(value)},[])
  useEffect(()=>()=>{pending.current?.resolve(false);pending.current=undefined},[])
  const confirm=useCallback((next:ConfirmOptions)=>{
    if(pending.current)return Promise.resolve(false)
    let resolve!:(value:boolean)=>void
    const promise=new Promise<boolean>(done=>{resolve=done})
    pending.current={promise,resolve};setOptions(next);return promise
  },[])
  const confirmation=options?<DialogFrame title={options.title} size="confirm" close={()=>finish(false)} footer={<><Button onClick={()=>finish(false)}>取消</Button><Button variant={options.danger?'danger':'primary'} onClick={()=>finish(true)}>{options.confirmLabel??'确认'}</Button></>}>{options.body}</DialogFrame>:null
  return {confirm,confirmation,cancel:()=>finish(false)}
}

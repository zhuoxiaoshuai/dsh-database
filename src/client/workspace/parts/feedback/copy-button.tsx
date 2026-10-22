import React,{useState,useEffect} from 'react'
import {copyText} from './clipboard.ts'
export function CopyButton({text,children,className='db-text-button',...props}:Omit<React.ButtonHTMLAttributes<HTMLButtonElement>,'onClick'>&{text:string|(()=>string)}){
  const [result,setResult]=useState<boolean>()
  useEffect(()=>setResult(undefined),[text])
  return <><button {...props} type="button" className={className} onClick={()=>void copyText(typeof text==='function'?text():text).then(setResult)}>{children}</button>{result!==undefined&&<span className={result?'db-muted':'db-error'} role="status">{result?'已复制':'复制失败，请选中文字复制'}</span>}</>
}

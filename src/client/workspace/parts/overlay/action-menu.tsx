import React,{useRef,useState} from 'react'
import {ChevronDown,Info} from 'lucide-react'
import {createPortal} from 'react-dom'
import {MenuSurface} from './menu.tsx'
import {useFloatingSurface} from './floating-surface.tsx'
export function ActionMenu({children,label='更多',help=false,icon}: {children:React.ReactNode;label?:string;help?:boolean;icon?:React.ReactNode}) {
  const trigger=useRef<HTMLButtonElement>(null),popup=useRef<HTMLDivElement>(null)
  const [open,setOpen]=useState(false)
  const close=(restore=true)=>{setOpen(false);if(restore)trigger.current?.focus({preventScroll:true})}
  const {theme,position}=useFloatingSurface({open:open&&help,anchor:trigger,surface:popup,close,width:300,focus:true})
  return <><button ref={trigger} type="button" className={help||icon?'db-icon-button':'db-text-button'} title={label} aria-label={label} aria-haspopup={help?'dialog':'menu'} aria-expanded={open} onClick={()=>setOpen(!open)}>{icon||(help?<Info size={14}/>:<>更多<ChevronDown size={14}/></>)}</button>
    {open&&!help&&<MenuSurface anchor={{element:trigger.current}} close={()=>setOpen(false)} label={label}>{children}</MenuSurface>}
    {open&&help&&createPortal(<div ref={popup} className={`db-workbench db-popover-layer${theme.dark?' db-dark':''}`} {...theme.attributes} data-db-parent-dialog={trigger.current?.closest('[data-db-dialog-id]')?.getAttribute('data-db-dialog-id')} style={{...theme.style,...position}} role="dialog" aria-label={label} tabIndex={-1} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close()}}}>{children}</div>,document.body)}
  </>
}
export function ResourceHelp({label='使用说明',children}: {label?:string;children:React.ReactNode}) {
  return <ActionMenu label={label} help><div className="db-help-content">{children}</div></ActionMenu>
}

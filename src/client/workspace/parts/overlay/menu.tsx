import React, {useRef} from 'react'
import {createPortal} from 'react-dom'
import {useFloatingSurface, type MenuAnchor} from './floating-surface.tsx'

function menuItems(children:React.ReactNode):React.ReactNode{
  return React.Children.map(children,child=>{
    if(!React.isValidElement(child))return child
    const props=child.props as React.ButtonHTMLAttributes<HTMLButtonElement>&{children?:React.ReactNode}
    if(child.type==='button')return React.cloneElement(child as React.ReactElement<React.ButtonHTMLAttributes<HTMLButtonElement>>,{role:props.role??'menuitem',disabled:false,'aria-disabled':props.disabled||props['aria-disabled']||undefined,onClick:event=>{if(props.disabled||props['aria-disabled']===true||props['aria-disabled']==='true'){event.preventDefault();event.stopPropagation();return}props.onClick?.(event)}})
    return props.children?React.cloneElement(child as React.ReactElement<{children?:React.ReactNode}>,{},menuItems(props.children)):child
  })
}

export function MenuSurface({anchor,close,label,children}: {anchor:MenuAnchor;close():void;label:string;children:React.ReactNode}) {
  const trigger=useRef(anchor.element),popup=useRef<HTMLDivElement>(null)
  trigger.current=anchor.element
  const dismiss=(restore=true)=>{close();if(restore) trigger.current?.focus({preventScroll:true})}
  const {theme,position}=useFloatingSurface({open:true,anchor:trigger,surface:popup,close:dismiss,point:anchor.x===undefined?undefined:{x:anchor.x,y:anchor.y!},focus:true,exclusive:true})
  return createPortal(<div ref={popup} className={`db-workbench db-popover-layer db-operation-menu${theme.dark?' db-dark':''}`} {...theme.attributes}
    data-db-parent-dialog={trigger.current?.closest('[data-db-dialog-id]')?.getAttribute('data-db-dialog-id')}
    style={{...theme.style,...position}} role="menu" aria-label={label} tabIndex={-1}
    onPointerDown={event=>event.stopPropagation()}
    onClick={event=>{event.stopPropagation();if((event.target as Element).closest('button:not(:disabled):not([aria-disabled="true"])')) dismiss()}}
    onKeyDown={event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismiss();return}
      if(event.key==='Tab'){dismiss(false);return}
      if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return
      const buttons=[...popup.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      if(!buttons.length)return
      event.preventDefault();const index=buttons.indexOf(document.activeElement as HTMLButtonElement)
      buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus()
    }}>{menuItems(children)}</div>,document.body)
}

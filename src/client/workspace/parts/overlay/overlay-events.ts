import {useLayoutEffect,useRef,type RefObject} from 'react'
const groups=new WeakMap<Element,Set<()=>void>>()
const owners=new WeakMap<Element,Element>()
export function workbenchBoundary(anchor:Element|null){
  for(let node=anchor;node;node=node.parentElement){const owner=owners.get(node);if(owner)return owner}
  return anchor?.closest('.db-workbench:not(.db-popover-layer):not(.db-grid-menu-layer):not(.db-search-select-menu)')??null
}
export function useOverlayEvents({open,anchor,surface,close,exclusive=false,includeAnchor=true}: {open:boolean;anchor:RefObject<HTMLElement|null>;surface:RefObject<HTMLElement|null>;close(restore?:boolean):void;exclusive?:boolean;includeAnchor?:boolean}){
  const latest=useRef(close);latest.current=close
  useLayoutEffect(()=>{
    if(!open)return
    const owner=workbenchBoundary(anchor.current),dismiss=()=>latest.current(false)
    const popup=surface.current
    if(owner&&popup)owners.set(popup,owner)
    if(exclusive&&owner){const siblings=groups.get(owner)??new Set<()=>void>();for(const sibling of siblings)sibling();siblings.add(dismiss);groups.set(owner,siblings)}
    const outside=(event:PointerEvent)=>{const target=event.target as Node;if(!surface.current?.contains(target)&&(!includeAnchor||!anchor.current?.contains(target)))latest.current(false)}
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&(surface.current?.contains(document.activeElement)||anchor.current?.contains(document.activeElement))){event.preventDefault();event.stopPropagation();latest.current(true)}}
    window.addEventListener('pointerdown',outside);window.addEventListener('keydown',key)
    return()=>{if(popup)owners.delete(popup);if(owner)groups.get(owner)?.delete(dismiss);window.removeEventListener('pointerdown',outside);window.removeEventListener('keydown',key)}
  },[open,exclusive,includeAnchor])
}

import {useOverlayEvents,workbenchBoundary} from './overlay-events.ts'
export {workbenchBoundary} from './overlay-events.ts'
import {useLayoutEffect, useRef, useState, type RefObject} from 'react'
import {useWorkbenchTheme} from '../theme/use-workbench-theme.ts'

export type MenuAnchor = {element: HTMLElement | null; x?: number; y?: number}
export function useFloatingSurface({open, anchor, surface, close, width = 260, point, focus = false, exclusive = false}: {
  open: boolean; anchor: RefObject<HTMLElement | null>; surface: RefObject<HTMLElement | null>; close(restore?: boolean): void;
  width?: number; point?: {x:number;y:number}; focus?: boolean; exclusive?: boolean;
}) {
  const latest = useRef(close); latest.current = close
  useOverlayEvents({open,anchor,surface,close,exclusive})
  const theme = useWorkbenchTheme(anchor.current)
  const [position,setPosition] = useState({left:0,top:0,width,maxHeight:300})
  useLayoutEffect(() => {
    if (!open) return
    const owner = workbenchBoundary(anchor.current)
    const place = () => {
      if (!anchor.current?.isConnected || !anchor.current.getClientRects().length || !surface.current) {latest.current(false); return}
      const bounds = owner?.getBoundingClientRect()
      const left = Math.max(0,bounds?.left ?? 0)+8, right = Math.min(window.innerWidth,bounds?.right ?? window.innerWidth)-8
      const top = Math.max(0,bounds?.top ?? 0)+8, bottom = Math.min(window.innerHeight,bounds?.bottom ?? window.innerHeight)-8
      const rect = anchor.current.getBoundingClientRect(), actualWidth = Math.max(0,Math.min(width,right-left))
      const height = Math.min(surface.current.scrollHeight,Math.max(0,bottom-top))
      const x = point?.x ?? rect.right-actualWidth
      const y = point?.y ?? rect.bottom+4
      const actualTop = Math.max(top,Math.min(y+height>bottom ? (point ? bottom-height : rect.top-height-4) : y,bottom-height))
      setPosition(previous => {
        const next = {left:Math.max(left,Math.min(x,right-actualWidth)),top:actualTop,width:actualWidth,maxHeight:Math.max(0,bottom-actualTop)}
        return Object.keys(next).every(key=>next[key as keyof typeof next]===previous[key as keyof typeof next]) ? previous : next
      })
    }
    place()
    if (focus) (surface.current?.querySelector<HTMLElement>('button:not(:disabled),[tabindex="0"]') ?? surface.current)?.focus({preventScroll:true})
    const scroll = (event:Event) => {
      if (surface.current?.contains(event.target as Node)) return
      if (point) latest.current(false); else place()
    }
    const observer = new ResizeObserver(place)
    if (owner) observer.observe(owner)
    if (surface.current) observer.observe(surface.current)
    const mutations=new MutationObserver(()=>{if(!anchor.current?.isConnected||!anchor.current.getClientRects().length)latest.current(false)})
    if(owner)mutations.observe(owner,{subtree:true,attributes:true,attributeFilter:['hidden','aria-hidden','class'],childList:true})
    window.addEventListener('resize',place); window.addEventListener('scroll',scroll,true)
    return () => {
      observer.disconnect();mutations.disconnect()
      window.removeEventListener('resize',place); window.removeEventListener('scroll',scroll,true)
    }
  },[open,width,point?.x,point?.y,focus,exclusive])
  return {theme,position}
}

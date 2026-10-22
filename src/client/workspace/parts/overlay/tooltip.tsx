import React,{useEffect,useRef} from 'react'
import {resolveWorkbenchTheme,subscribeWorkbenchTheme} from '../theme/workbench-theme.ts'
import {workbenchBoundary} from './overlay-events.ts'
const installed=new WeakMap<Element,{count:number;dispose():void}>()
/** One delegated tooltip host per workbench, including controls supplied by source modules. */
export function WorkbenchTooltips(){
  const marker=useRef<HTMLSpanElement>(null)
  useEffect(()=>{
    const owner=marker.current?.closest('.db-workbench')
    if(!owner)return
    const current=installed.get(owner)
    if(current){current.count++;return()=>{if(--current.count===0){current.dispose();installed.delete(owner)}}}
    let target:HTMLElement|null=null,timer:number|undefined,tip:HTMLDivElement|null=null,title='',description:string|null=null
    const hide=()=>{
      window.clearTimeout(timer);tip?.remove();tip=null
      if(target){target.setAttribute('title',title);delete target.dataset.dbTooltip;if(description===null)target.removeAttribute('aria-describedby');else target.setAttribute('aria-describedby',description)}
      target=null
    }
    const render=()=>{
      if(!target?.isConnected||!tip){hide();return}
      const theme=resolveWorkbenchTheme(undefined,target)
      for(const [key,value] of Object.entries(theme.variables))tip.style.setProperty(key,value)
      tip.dataset.dbPalette=theme.paletteId;tip.dataset.dbScheme=theme.scheme
      const boundary=owner.getBoundingClientRect(),rect=target.getBoundingClientRect(),width=Math.min(300,Math.max(0,boundary.width-16))
      tip.style.maxWidth=width+'px'
      const box=tip.getBoundingClientRect(),left=Math.max(boundary.left+8,Math.min(rect.left,boundary.right-box.width-8))
      const top=rect.bottom+box.height+6<=boundary.bottom-8?rect.bottom+6:Math.max(boundary.top+8,rect.top-box.height-6)
      tip.style.left=left+'px';tip.style.top=top+'px'
    }
    const show=(element:HTMLElement,delay:number)=>{
      if(target===element)return
      hide();title=element.getAttribute('title')??'';if(!title)return
      target=element;description=element.getAttribute('aria-describedby');element.dataset.dbTooltip=title;element.removeAttribute('title')
      timer=window.setTimeout(()=>{
        if(!target)return
        tip=document.createElement('div');tip.className='db-tooltip-layer';tip.id='db-tooltip-'+crypto.randomUUID();tip.setAttribute('role','tooltip');tip.textContent=title
        target.setAttribute('aria-describedby',[description,tip.id].filter(Boolean).join(' '));document.body.append(tip);render()
      },delay)
    }
    const enter=(event:Event)=>{const el=(event.target as Element)?.closest<HTMLElement>('[title],[data-db-tooltip]');if(el&&workbenchBoundary(el)===owner)show(el,event.type==='focusin'?0:300)}
    const leave=(event:Event)=>{if(target&&!target.contains((event as FocusEvent).relatedTarget as Node))hide()}
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape')hide()}
    document.addEventListener('pointerover',enter);document.addEventListener('pointerout',leave);document.addEventListener('focusin',enter);document.addEventListener('focusout',leave)
    window.addEventListener('keydown',key);window.addEventListener('scroll',hide,true);window.addEventListener('resize',hide)
    const stop=subscribeWorkbenchTheme(render)
    const entry={count:1,dispose:()=>{hide();stop();document.removeEventListener('pointerover',enter);document.removeEventListener('pointerout',leave);document.removeEventListener('focusin',enter);document.removeEventListener('focusout',leave);window.removeEventListener('keydown',key);window.removeEventListener('scroll',hide,true);window.removeEventListener('resize',hide)}}
    installed.set(owner,entry)
    return()=>{if(--entry.count===0){entry.dispose();installed.delete(owner)}}
  },[])
  return <span ref={marker} hidden aria-hidden="true"/>
}

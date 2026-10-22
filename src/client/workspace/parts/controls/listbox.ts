import type {KeyboardEvent} from 'react'
/** List selection keeps option semantics, separate from operation menus. */
export function listboxKeyDown(event:KeyboardEvent,menu:HTMLElement|null,close:()=>void){
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return}
  if(!menu||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return
  const items=[...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
  if(!items.length)return
  event.preventDefault();const index=items.indexOf(document.activeElement as HTMLButtonElement)
  const next=event.key==='Home'?0:event.key==='End'?items.length-1:index<0?(event.key==='ArrowDown'?0:items.length-1):(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length
  items[next]?.focus({preventScroll:true});items[next]?.scrollIntoView({block:'nearest'})
}

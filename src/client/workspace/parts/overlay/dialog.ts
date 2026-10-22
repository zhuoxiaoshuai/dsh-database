import { useEffect, useRef, type MouseEvent, type RefObject } from 'react'

/** Close only when press and release both hit the dimmed backdrop, not a text-select drag that ends outside the dialog. */
export function shouldDismissBackdrop(pointerDownOnBackdrop: boolean, target: EventTarget | null, backdrop: EventTarget | null): boolean {
  return pointerDownOnBackdrop && !!backdrop && target === backdrop
}

export function useBackdropDismiss(close: () => void) {
  const started = useRef(false)
  const latestClose = useRef(close)
  latestClose.current = close
  return {
    onMouseDown(event: MouseEvent<HTMLElement>) {
      started.current = event.target === event.currentTarget
    },
    onClick(event: MouseEvent<HTMLElement>) {
      const hit = shouldDismissBackdrop(started.current, event.target, event.currentTarget)
      started.current = false
      if (hit) latestClose.current()
    },
  }
}

const stacks = new WeakMap<Element, HTMLElement[]>()
/** Modal keyboard ownership is scoped to one workbench; portal children belong to the active dialog. */
export function useDialog(ref: RefObject<HTMLElement | null>, close: () => void, active = true, returnFocus?: RefObject<HTMLElement | null>) {
  const latestClose = useRef(close); latestClose.current = close
  useEffect(() => {
    const node=ref.current
    if(!node||!active)return
    const owner=node.closest('.db-workbench')??node.parentElement!
    const stack=stacks.get(owner)??[];stack.push(node);stacks.set(owner,stack)
    const previous=document.activeElement as HTMLElement|null
    const owned=()=>[node,...Array.from(document.querySelectorAll<HTMLElement>('[data-db-parent-dialog]')).filter(el=>el.dataset.dbParentDialog===node.dataset.dbDialogId)]
    const controls=()=>owned().flatMap(el=>Array.from(el.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]'))).filter(el=>el.getClientRects().length&&!el.closest('[aria-hidden="true"],[inert]'))
    ;(controls()[0]??node).focus({preventScroll:true})
    const keyboard=(event:KeyboardEvent)=>{
      if(stack.filter(item=>item.getClientRects().length).at(-1)!==node)return
      if(event.key==='Escape'){
        if(owned().slice(1).some(el=>el.contains(document.activeElement)))return
        event.preventDefault();event.stopPropagation();latestClose.current()
      }
      if(event.key!=='Tab')return
      const items=controls(),first=items[0],last=items.at(-1)
      if(!first){event.preventDefault();node.focus();return}
      if(event.shiftKey&&(document.activeElement===first||document.activeElement===node)){event.preventDefault();last?.focus()}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
    }
    const focus=(event:FocusEvent)=>{
      if(stack.filter(item=>item.getClientRects().length).at(-1)!==node)return
      const target=event.target as Node
      if(owner.contains(target)&&!owned().some(el=>el.contains(target)))(controls()[0]??node).focus({preventScroll:true})
    }
    document.addEventListener('keydown',keyboard);document.addEventListener('focusin',focus)
    return()=>{
      document.removeEventListener('keydown',keyboard);document.removeEventListener('focusin',focus)
      const index=stack.indexOf(node);if(index>=0)stack.splice(index,1)
      const destination=returnFocus?.current??previous
      if(destination?.isConnected)destination.focus({preventScroll:true})
    }
  },[ref,active])
}

import {useOverlayEvents,workbenchBoundary} from '../workspace/parts/overlay/overlay-events.ts'
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useWorkbenchTheme } from '../workspace/parts/theme/use-workbench-theme.ts'
import { placeCopyMenu, type MenuPlacement } from './placement.ts'

export type CopyAction = 'cell' | 'field' | 'rows' | 'insert' | 'tsv-fields' | 'tsv-values' | 'tsv-both' | 'comma-fields' | 'comma-values' | 'comma-both'
type Submenu = 'tsv' | 'comma'

export function GridCopyMenu({ x, y, anchor, header, extra, onPick, onClose }: {
  x: number
  y: number
  anchor: HTMLElement | null
  header?: boolean
  extra?: React.ReactNode
  onPick(action: CopyAction): void
  onClose(): void
}): React.ReactElement {
  const owner=useRef(anchor);owner.current=anchor
  const layer = useRef<HTMLDivElement>(null)
  useOverlayEvents({open:true,anchor:owner,surface:layer,close:onClose,exclusive:true,includeAnchor:false})
  const main = useRef<HTMLDivElement>(null)
  const fly = useRef<HTMLDivElement>(null)
  const trigger = useRef<Record<Submenu, HTMLButtonElement | null>>({ tsv: null, comma: null })
  const timer = useRef<number | undefined>(undefined)
  const [active, setActive] = useState<Submenu>()
  const [place, setPlace] = useState<MenuPlacement>({ left: x, top: y, flyLeft: x, flyTop: y, inline: false })
  const keep = () => window.clearTimeout(timer.current)
  const show = (next: Submenu) => { keep(); setActive(next) }
  const hide = () => { keep(); timer.current = window.setTimeout(() => setActive(undefined), 160) }
  const pick = (action: CopyAction) => { onPick(action); onClose() }

  useLayoutEffect(() => {
    const measure = () => {
      if (!main.current) return
      const mainRect = main.current.getBoundingClientRect()
      const flyRect = fly.current?.getBoundingClientRect()
      const itemRect = active ? trigger.current[active]?.getBoundingClientRect() : undefined
      const boundary=workbenchBoundary(anchor)?.getBoundingClientRect()
      const origin={left:Math.max(0,boundary?.left??0),top:Math.max(0,boundary?.top??0)}
      const width=Math.min(window.innerWidth,boundary?.right??window.innerWidth)-origin.left
      const height=Math.min(window.innerHeight,boundary?.bottom??window.innerHeight)-origin.top
      const local = placeCopyMenu(x-origin.left, y-origin.top, mainRect, active ? { width: flyRect?.width ?? 156, height: flyRect?.height ?? 0 } : undefined,
        itemRect ? itemRect.top - mainRect.top : 0, {width,height})
      const next={...local,left:local.left+origin.left,top:local.top+origin.top,flyLeft:local.flyLeft+origin.left,flyTop:local.flyTop+origin.top}
      setPlace(current => Object.keys(next).every(key => next[key as keyof MenuPlacement] === current[key as keyof MenuPlacement]) ? current : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (main.current) observer.observe(main.current)
    if (fly.current) observer.observe(fly.current)
    window.addEventListener('resize', measure)
    const onScroll = (event: Event) => {
      if (main.current?.contains(event.target as Node)) measure()
      else if (!layer.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('scroll', onScroll, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', onScroll, true) }
  }, [x, y, active, place.inline, onClose])

  useEffect(() => {
    main.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [])

  useEffect(()=>()=>keep(),[])

  const onKeyDown = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();return}
    if (event.key === 'Tab') { onClose(); return }
    if (event.key === 'ArrowRight' && target.dataset.submenu) {
      event.preventDefault(); show(target.dataset.submenu as Submenu)
      requestAnimationFrame(() => layer.current?.querySelector<HTMLElement>('.db-grid-copy-options button')?.focus())
    } else if (event.key === 'ArrowLeft' && active) {
      event.preventDefault(); trigger.current[active]?.focus(); setActive(undefined)
    } else if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
      const menu = target.closest('[role=menu]')
      const buttons = Array.from(menu?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
      if (!buttons.length) return
      event.preventDefault()
      const index = buttons.indexOf(target as HTMLButtonElement)
      buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    }
  }

  const options = (kind: Submenu) => <>
    <button type="button" role="menuitem" onClick={() => pick(`${kind}-fields`)}>字段</button>
    <button type="button" role="menuitem" onClick={() => pick(`${kind}-values`)}>数据</button>
    <button type="button" role="menuitem" onClick={() => pick(`${kind}-both`)}>字段名和数据</button>
  </>
  const theme = useWorkbenchTheme(anchor)
  return createPortal(<div ref={layer} {...theme.attributes} style={theme.style} data-db-parent-dialog={anchor?.closest('[data-db-dialog-id]')?.getAttribute('data-db-dialog-id')} className={`db-workbench db-grid-menu-layer${theme.dark ? ' db-dark' : ''}`} onKeyDown={onKeyDown} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
    <div ref={main} className="db-dropdown db-context-menu db-grid-copy-menu" style={{left:place.left,top:place.top,maxWidth:Math.max(0,(workbenchBoundary(anchor)?.clientWidth??window.innerWidth)-16),maxHeight:Math.max(0,(workbenchBoundary(anchor)?.clientHeight??window.innerHeight)-16)}} role="menu" aria-label="结果复制菜单">
      <button type="button" role="menuitem" onClick={() => pick(header ? 'tsv-values' : 'cell')}>复制</button>
      <button type="button" role="menuitem" onClick={() => pick('field')}>复制字段名</button>
      {!header && <>
        <button type="button" role="menuitem" onClick={() => pick('rows')}>复制整行内容</button>
        <button type="button" role="menuitem" onClick={() => pick('insert')}>整行复制为 INSERT</button>
      </>}
      <div className="db-grid-menu-divider" role="separator" />
      {(['tsv', 'comma'] as const).map(kind => <div className="db-grid-copy-sub" key={kind} onMouseEnter={() => show(kind)} onMouseLeave={hide}>
        <button ref={node => { trigger.current[kind] = node }} type="button" role="menuitem" data-submenu={kind} aria-haspopup="menu" aria-expanded={active === kind}
          onClick={() => show(kind)}>
          <span>{kind === 'tsv' ? '制表符分隔' : '逗号分隔'}</span><span className="db-grid-menu-arrow" aria-hidden="true">›</span>
        </button>
        {active === kind && place.inline && <div className="db-grid-copy-options db-grid-copy-inline" role="menu" aria-label={kind === 'tsv' ? '制表符分隔' : '逗号分隔'}>{options(kind)}</div>}
      </div>)}
      {extra && <><div className="db-grid-menu-divider" role="separator" /><div className="db-grid-copy-extra" onClick={onClose}>{extra}</div></>}
    </div>
    {active && !place.inline && <div ref={fly} className="db-dropdown db-context-menu db-grid-copy-fly db-grid-copy-options" style={{left:place.flyLeft,top:place.flyTop,maxHeight:Math.max(0,(workbenchBoundary(anchor)?.clientHeight??window.innerHeight)-16)}} role="menu" aria-label={active === 'tsv' ? '制表符分隔' : '逗号分隔'} onMouseEnter={keep} onMouseLeave={hide}>{options(active)}</div>}
  </div>, document.body)
}

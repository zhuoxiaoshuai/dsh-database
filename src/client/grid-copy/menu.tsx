import React, { useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type CopyAction = 'cell' | 'field' | 'rows' | 'insert' | 'tsv-fields' | 'tsv-values' | 'tsv-both' | 'csv-fields' | 'csv-values' | 'csv-both'

export function GridCopyMenu({
  x, y, extra, onPick, onClose,
}: {
  x: number
  y: number
  extra?: React.ReactNode
  onPick(action: CopyAction): void
  onClose(): void
}): React.ReactElement {
  return <div className="db-dropdown db-context-menu db-grid-copy-menu" style={{ position: 'fixed', left: x, top: y }} role="menu" onClick={onClose} onMouseDown={event => event.stopPropagation()}>
    <button type="button" onClick={() => onPick('cell')}>复制</button>
    <button type="button" onClick={() => onPick('field')}>复制字段名</button>
    <button type="button" onClick={() => onPick('rows')}>复制整行内容</button>
    <button type="button" onClick={() => onPick('insert')}>整行复制为 INSERT</button>
    <CopySubmenu label="选中部分制表符分隔值">
      <button type="button" onClick={() => onPick('tsv-fields')}>字段</button>
      <button type="button" onClick={() => onPick('tsv-values')}>数据</button>
      <button type="button" onClick={() => onPick('tsv-both')}>数据和字段名</button>
    </CopySubmenu>
    <CopySubmenu label="逗号分隔">
      <button type="button" onClick={() => onPick('csv-fields')}>字段</button>
      <button type="button" onClick={() => onPick('csv-values')}>数据</button>
      <button type="button" onClick={() => onPick('csv-both')}>字段名和数据</button>
    </CopySubmenu>
    {extra}
  </div>
}

function CopySubmenu({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  const item = useRef<HTMLDivElement>(null)
  const timer = useRef(0)
  const [box, setBox] = useState<{ left: number; top: number }>()
  const show = () => {
    window.clearTimeout(timer.current)
    const node = item.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    const width = 168
    const height = 132
    let left = rect.right + 2
    let top = rect.top
    if (left + width > window.innerWidth - 8) left = Math.max(8, rect.left - width - 2)
    if (top + height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - height - 8)
    setBox({ left, top })
  }
  const hide = () => {
    timer.current = window.setTimeout(() => setBox(undefined), 160)
  }
  const host = item.current?.closest('.db-workbench') ?? document.body
  return <div className="db-grid-copy-sub" ref={item} onMouseEnter={show} onMouseLeave={hide}>
    <button type="button" onClick={event => { event.stopPropagation(); box ? setBox(undefined) : show() }}>{label}</button>
    {box && createPortal(
      <div className="db-dropdown db-context-menu db-grid-copy-fly" style={{ position: 'fixed', left: box.left, top: box.top }} role="menu" onMouseEnter={show} onMouseLeave={hide} onMouseDown={event => event.stopPropagation()}>
        {children}
      </div>,
      host,
    )}
  </div>
}

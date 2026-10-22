import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PaneGutter } from '../shell/pane-gutter.tsx'
import { useDragResize } from '../parts/hooks/use-drag-resize.ts'
import { DockSplitContext } from '../../dock-split-context.ts'
import { clampSplitRatio, ratioAfterDrag, splitGridRows, stealEditorPixels, SQL_PANE_GUTTER, SQL_SPLIT_RATIO_DEFAULT } from '../../sql-pane-layout.ts'
import { usePanelSize } from '../parts/hooks/use-panel-size.ts'

/** The editor and result renderer belong to the source; split, resize and collapse belong here. */
export function ExecutionWorkbench({ className = '', toolbar, editor, result, rail, resultOpen: controlledResultOpen,
  onResultOpenChange, resultKey, editorOpen: controlledEditorOpen, onEditorOpenChange, editorRatio: controlledRatio, onRatioChange,
}: {
  className?: string
  toolbar?: React.ReactNode
  editor: React.ReactNode | ((visible: boolean) => React.ReactNode)
  result: React.ReactNode
  rail?: React.ReactNode
  resultKey?: string
  resultOpen?: boolean
  onResultOpenChange?(open: boolean): void
  editorOpen?: boolean
  onEditorOpenChange?(open: boolean): void
  editorRatio?: number
  onRatioChange?(ratio: number): void
}): React.ReactElement {
  const splitRef = useRef<HTMLDivElement>(null)
  const size = usePanelSize(splitRef)
  const compact = size.width > 0 && (size.width < 480 || size.height < 420)
  const [compactView, setCompactView] = useState<'editor'|'result'>('editor')
  const [localResultOpen, setLocalResultOpen] = useState(true)
  const [localEditorOpen, setLocalEditorOpen] = useState(true)
  const [localRatio, setLocalRatio] = useState(SQL_SPLIT_RATIO_DEFAULT)
  const [splitHeight, setSplitHeight] = useState(0)
  const resultOpen = controlledResultOpen ?? localResultOpen
  const editorOpen = controlledEditorOpen ?? localEditorOpen
  const ratio = controlledRatio ?? localRatio
  const setResultOpen = (next: boolean) => { onResultOpenChange?.(next); if (controlledResultOpen === undefined) setLocalResultOpen(next) }
  const seenResult = useRef<string>()
  useEffect(() => {
    if (!resultKey || resultKey === seenResult.current) return
    seenResult.current = resultKey
    setResultOpen(true)
    setCompactView('result')
  }, [resultKey])
  const previousResultOpen = useRef(resultOpen)
  useEffect(() => { if (resultOpen && !previousResultOpen.current) setCompactView('result'); previousResultOpen.current = resultOpen }, [resultOpen])
  const setEditorOpen = (next: boolean) => { onEditorOpenChange?.(next); if (controlledEditorOpen === undefined) setLocalEditorOpen(next) }
  const setRatio = (next: number) => {
    const available = Math.max(0, (splitRef.current?.clientHeight || splitHeight) - SQL_PANE_GUTTER)
    const clamped = clampSplitRatio(next, available)
    onRatioChange?.(clamped)
    if (controlledRatio === undefined) setLocalRatio(clamped)
  }
  const stealOrigin = useRef(0)
  const stealEditor = useCallback((pixels: number) => {
    if (!editorOpen || !resultOpen) return 0
    const height = splitRef.current?.clientHeight || splitHeight
    const { ratio: next, stolen } = stealEditorPixels(stealOrigin.current, height, pixels)
    if (stolen) setRatio(next)
    return stolen
  }, [editorOpen, resultOpen, splitHeight])
  const beginSteal = useCallback(() => { stealOrigin.current = ratio }, [ratio])
  const dockSplit = useMemo(() => ({ beginSteal, stealEditor }), [beginSteal, stealEditor])
  const onHandle = useDragResize((start, next) => setRatio(ratioAfterDrag(ratio, next.clientY - start.clientY, splitRef.current?.clientHeight || splitHeight)))
  useEffect(() => {
    const node = splitRef.current
    if (!node) return
    const measure = () => setSplitHeight(node.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const collapseEditor = () => { if (!resultOpen) setResultOpen(true); setEditorOpen(false) }
  const collapseResult = () => { if (!editorOpen) setEditorOpen(true); setResultOpen(false) }
  return <DockSplitContext.Provider value={dockSplit}>
    <div className={`${className}${resultOpen ? ' is-result-open' : ' is-result-collapsed'}${editorOpen ? '' : ' is-editor-collapsed'}${compact ? ` is-compact-view showing-${compactView}` : ''}`}>
      {compact && <div className="db-execution-view-switch" role="tablist" aria-label="编辑与结果"><button type="button" role="tab" aria-selected={compactView==='editor'} onClick={()=>{setEditorOpen(true);setCompactView('editor')}}>编辑</button><button type="button" role="tab" aria-selected={compactView==='result'} onClick={()=>{setResultOpen(true);setCompactView('result')}}>结果</button></div>}
      {editorOpen && toolbar}
      <div className="db-sql-split" ref={splitRef} style={{ gridTemplateRows: compact ? 'minmax(0,1fr)' : splitGridRows(editorOpen, resultOpen, ratio, splitHeight) }}>
        <div className="db-sql-editor-row" style={editorOpen ? undefined : { display: 'none' }}>{typeof editor === 'function' ? editor(editorOpen) : editor}</div>
        {!editorOpen && <PaneGutter axis="y" collapsed collapsedEdge="start" onExpand={() => setEditorOpen(true)} start={rail} />}
        {editorOpen && resultOpen && <PaneGutter axis="y" onCollapseStart={collapseEditor} onCollapseEnd={collapseResult} onResize={onHandle} />}
        {resultOpen && <div className="db-sql-result"><div className="db-sql-result-body">{result}</div></div>}
        {!resultOpen && <PaneGutter axis="y" collapsed collapsedEdge="end" onExpand={() => setResultOpen(true)} />}
      </div>
    </div>
  </DockSplitContext.Provider>
}

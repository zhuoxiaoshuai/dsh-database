import React, { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, highlightActiveLine, lineNumbers } from '@codemirror/view'
import { MergeView } from '@codemirror/merge'
import { workbenchEditorTheme, workbenchHighlighting } from '../theme/editor-theme.ts'

export type TextDiffIssue = { from: number; to: number; line: number; column: number; message: string }

const noLanguage: Extension[] = []
const noIssues: readonly TextDiffIssue[] = []

class TextDiffIssueWidget extends WidgetType {
  constructor(readonly message: string) { super() }
  toDOM() { const node = document.createElement('span'); node.className = 'db-config-issue-inline'; node.textContent = this.message; node.title = this.message; return node }
}

/** Read-only before/after text. Callers supply language extensions; this view does not execute the text. */
export function TextDiff({ before, after, extensions: language = noLanguage, extensionKey = '', issues = noIssues, note, beforeLabel = '变更前', afterLabel = '变更后', autoFocus = false, label = '文本差异' }: {
  before: string
  after: string
  extensions?: Extension[]
  extensionKey?: string
  issues?: readonly TextDiffIssue[]
  note?: string
  beforeLabel?: string
  afterLabel?: string
  autoFocus?: boolean
  label?: string
}): React.ReactElement {
  const root = useRef<HTMLDivElement>(null)
  const merge = useRef<MergeView>()
  const position = useRef(-1)
  const [navigation, setNavigation] = useState({ index: -1, total: 0 })
  const move = (direction: number) => {
    const view = merge.current
    if (!view?.chunks.length) return
    const index = position.current < 0 ? (direction > 0 ? 0 : view.chunks.length - 1) : (position.current + direction + view.chunks.length) % view.chunks.length
    position.current = index
    const chunk = view.chunks[index]
    for (const [editor, offset] of [[view.a, chunk.fromA], [view.b, chunk.fromB]] as const) {
      const anchor = Math.min(offset, editor.state.doc.length)
      editor.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: 'center' }) })
    }
    setNavigation({ index, total: view.chunks.length })
  }
  const locateIssue = (issue: TextDiffIssue) => {
    const editor = merge.current?.b
    if (!editor) return
    const line = editor.state.doc.line(Math.min(issue.line, editor.state.doc.lines))
    const anchor = Math.min(line.to, line.from + issue.column - 1)
    editor.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: 'center' }) })
    editor.focus()
  }
  useEffect(() => {
    if (!root.current) return
    const extensions = [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ tabindex: '0' }), lineNumbers(), highlightActiveLine(), workbenchHighlighting, workbenchEditorTheme, ...language]
    const diagnosticMarks = EditorView.decorations.compute([], state => {
      const ranges = []
      const lines = new Set<number>()
      for (const issue of issues) {
        const from = after.slice(0, issue.from).replace(/\r\n?|\n/g, '\n').length
        const to = after.slice(0, issue.to).replace(/\r\n?|\n/g, '\n').length
        if (to > from) ranges.push(Decoration.mark({ class: 'db-config-error-range' }).range(from, to))
        const line = state.doc.line(Math.min(issue.line, state.doc.lines))
        if (lines.has(line.number)) continue
        lines.add(line.number)
        ranges.push(Decoration.line({ class: 'db-config-error-line' }).range(line.from))
        ranges.push(Decoration.widget({ widget: new TextDiffIssueWidget(issues.filter(item => item.line === issue.line).map(item => item.message).join('；')), side: 1 }).range(line.to))
      }
      return Decoration.set(ranges, true)
    })
    const view = new MergeView({ parent: root.current, a: { doc: before, extensions }, b: { doc: after, extensions: [...extensions, diagnosticMarks] }, highlightChanges: true, diffConfig: { scanLimit: 10000, timeout: 100 } })
    merge.current = view
    position.current = -1
    setNavigation({ index: -1, total: view.chunks.length })
    const frame = autoFocus ? requestAnimationFrame(() => root.current?.parentElement?.focus({ preventScroll: true })) : undefined
    return () => { if (frame !== undefined) cancelAnimationFrame(frame); merge.current = undefined; view.destroy() }
  }, [after, autoFocus, before, extensionKey, issues])
  return <section className={`db-config-diff-panel${navigation.index >= 0 ? ' is-navigated' : ''}`} tabIndex={0} aria-label="差异导航" onKeyDownCapture={event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    move(event.key === 'ArrowDown' ? 1 : -1)
  }}>
    <div className="db-config-diff-toolbar"><span className="db-resource-summary" aria-live="polite">{navigation.total ? `${navigation.index < 0 ? '—' : navigation.index + 1} / ${navigation.total} 处变更` : '无内容变更'}</span><span className="db-config-diff-hint">↑ / ↓ 定位变更</span>
      <button type="button" className="db-icon-button" aria-label="上一处变更" title="上一处变更（↑）" disabled={!navigation.total} onClick={() => move(-1)}><ArrowUp size={14} /></button>
      <button type="button" className="db-icon-button" aria-label="下一处变更" title="下一处变更（↓）" disabled={!navigation.total} onClick={() => move(1)}><ArrowDown size={14} /></button>
    </div>
    {note && <p className="db-info-note">{note}</p>}
    {!!issues.length && <div className="db-config-issues" role="alert"><strong>格式问题（{issues.length === 100 ? '前 100 项' : issues.length}），修正后才能发布</strong>{issues.map((issue, index) => <button type="button" className="db-text-button" key={index} onClick={() => locateIssue(issue)}>第 {issue.line} 行，第 {issue.column} 列 · {issue.message}</button>)}</div>}
    <div className="db-nacos-diff-labels"><span>{beforeLabel}</span><span>{afterLabel}</span></div>
    <div ref={root} className="db-nacos-diff" aria-label={label} />
  </section>
}

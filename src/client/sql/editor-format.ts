import { Annotation, EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'
import type { EditorView } from '@codemirror/view'
import type { SqlFormatRange, SqlFormatResult } from '../../shared/sql-format.ts'

export const sqlFormatEdit = Annotation.define<boolean>()
export type SqlEditorFormatRequest = {
  text: string
  range?: SqlFormatRange
  apply(result: SqlFormatResult): void
}
export type SqlEditorHandle = { captureFormat(): SqlEditorFormatRequest }

export function sqlFormatTransaction(state: EditorState, result: SqlFormatResult): TransactionSpec {
  const end = result.from + result.insert.length
  const reversed = state.selection.main.anchor > state.selection.main.head
  return {
    changes: { from: result.from, to: result.to, insert: result.insert },
    selection: EditorSelection.single(reversed ? end : result.from, reversed ? result.from : end),
    annotations: [sqlFormatEdit.of(true), isolateHistory.of('full')],
    scrollIntoView: true,
  }
}

export function captureSqlEditorFormat(view: EditorView, isCurrent: () => boolean): SqlEditorFormatRequest {
  if (view.state.selection.ranges.length !== 1) throw new Error('格式化只支持一个连续选区，请重新选择。')
  const text = view.state.doc.toString()
  const selection = view.state.selection.main
  const range = selection.empty ? undefined : { from: selection.from, to: selection.to }
  return { text, range, apply(result) {
    if (!isCurrent() || view.state.doc.toString() !== text) throw new Error('内容或连接已变化，请重新格式化；本地草稿已保留。')
    if (text === result.text) return
    // Use the captured direction even if the user moves the cursor while a save is pending.
    const spec = sqlFormatTransaction(view.state, result)
    const end = result.from + result.insert.length
    spec.selection = EditorSelection.single(selection.anchor > selection.head ? end : result.from, selection.anchor > selection.head ? result.from : end)
    view.dispatch(spec)
    view.focus()
  } }
}

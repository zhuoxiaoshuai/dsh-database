import { useEffect, useRef, type MutableRefObject } from 'react'
import { Annotation, EditorState, Transaction, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

export type EditorHostSetup<Props> = (current: MutableRefObject<Props>) => { extensions: Extension[]; dispose?(): void }
export const externalTextSync = Annotation.define<boolean>()
export const hasUserTextChange = (update: { transactions: readonly Transaction[] }) => update.transactions.some(transaction => transaction.docChanged && !transaction.annotation(externalTextSync))

/** CodeMirror lifetime and controlled-text sync are shared by SQL and command editors. */
export function useEditorHost<Props extends { value: string }>(props: Props, setup: EditorHostSetup<Props>) {
  const root = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const current = useRef(props)
  current.current = props
  useEffect(() => {
    if (!root.current) return
    const instanceSetup = setup(current)
    const instance = new EditorView({ parent: root.current, state: EditorState.create({ doc: current.current.value, extensions: instanceSetup.extensions }) })
    view.current = instance
    return () => { instance.destroy(); instanceSetup.dispose?.(); view.current = null }
  }, [])
  useEffect(() => {
    const instance = view.current
    if (!instance || instance.state.doc.toString() === props.value) return
    const oldLen = instance.state.doc.length
    const main = instance.state.selection.main
    const atEnd = main.head === oldLen
    const clamp = (offset: number) => Math.max(0, Math.min(offset, props.value.length))
    instance.dispatch({
      annotations: [externalTextSync.of(true), Transaction.addToHistory.of(false)],
      changes: { from: 0, to: oldLen, insert: props.value },
      selection: {
        anchor: atEnd && main.anchor === oldLen ? props.value.length : clamp(main.anchor),
        head: atEnd ? props.value.length : clamp(main.head),
      },
    })
  }, [props.value])
  return { root, view, current }
}

import {textEditorExtensions} from '../workspace/parts/controls/text-editor-extensions.ts'
import React, { useEffect } from 'react'
import { EditorView, keymap } from '@codemirror/view'
import { isolateHistory } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { KAFKA_DOCUMENT_MAX_LENGTH } from '../../shared/kafka-command.mjs'
import { createCompletionInteraction } from '../completion/interaction.ts'
import { hasUserTextChange, useEditorHost } from '../workspace/parts/hooks/editor-host.ts'
import { createKafkaCompletionSource, type KafkaNames } from './completion.ts'

export type KafkaEditorApi = {
  read(): { text: string; selection: string; from: number; to: number }
  append(text: string): void
}
export function KafkaCommandEditor(props: { value: string; disabled?: boolean; onChange(value: string): void; onRun(value: string): void; editorContext?: unknown; apiRef?: React.MutableRefObject<KafkaEditorApi | null>; onSelectionChange?(selection: string): void; onLimit?(message: string): void }): React.ReactElement {
  const { root, view } = useEditorHost(props, current => {
    const interaction = createCompletionInteraction(createKafkaCompletionSource(() => (current.current.editorContext as KafkaNames | undefined) || { topics: [], groups: [] }))
    return { extensions: [
      keymap.of([{ key: 'Mod-Enter', run: editor => {
        const selection = editor.state.selection.main
        current.current.onRun(current.current.apiRef ? (selection.empty ? editor.state.doc.toString() : editor.state.sliceDoc(selection.from, selection.to)) : editor.state.doc.toString())
        return true
      } }]),
      ...textEditorExtensions('Kafka 命令'), ...interaction.extensions,
      EditorState.changeFilter.of(transaction => {
        if (transaction.newDoc.length <= KAFKA_DOCUMENT_MAX_LENGTH) return true
        queueMicrotask(() => current.current.onLimit?.('查询内容不能超过 524288 字符，请精简后重试。'))
        return false
      }),
      EditorView.updateListener.of(update => {
        if (hasUserTextChange(update)) current.current.onChange(update.state.doc.toString())
        if (update.selectionSet || update.docChanged) {
          const selection = update.state.selection.main
          current.current.onSelectionChange?.(selection.empty ? '' : update.state.sliceDoc(selection.from, selection.to))
        }
      }),
    ], dispose: interaction.dispose }
  })
  useEffect(() => {
    if (!props.apiRef) return
    props.apiRef.current = {
      read: () => {
        const editor = view.current
        if (!editor) return { text: props.value, selection: '', from: 0, to: 0 }
        const selection = editor.state.selection.main
        return { text: editor.state.doc.toString(), selection: selection.empty ? '' : editor.state.sliceDoc(selection.from, selection.to), from: selection.from, to: selection.to }
      },
      append: text => {
        const editor = view.current
        if (!editor) return
        const previous = editor.state.doc.toString()
        const insert = `${previous.length && !previous.endsWith('\n') ? '\n' : ''}${text}\n`
        if (previous.length + insert.length > KAFKA_DOCUMENT_MAX_LENGTH) throw new Error('追加后查询内容超过 512 KiB 字符，请精简后重试。')
        editor.dispatch({ changes: { from: previous.length, insert }, selection: { anchor: previous.length + insert.length }, scrollIntoView: true, annotations: isolateHistory.of('full') })
        editor.focus()
      },
    }
    return () => { if (props.apiRef) props.apiRef.current = null }
  }, [props.apiRef])
  return <div className="db-command-editor" ref={root} />
}

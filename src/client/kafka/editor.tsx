import React from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { createCompletionInteraction } from '../completion/interaction.ts'
import { useEditorHost } from '../workspace/source/editor-host.ts'
import { createKafkaCompletionSource } from './completion.ts'

export function KafkaCommandEditor(props: { value: string; onChange(value: string): void; onRun(value: string): void }): React.ReactElement {
  const { root } = useEditorHost(props, current => {
    const interaction = createCompletionInteraction(createKafkaCompletionSource())
    return { extensions: [
      history(), EditorView.lineWrapping, EditorState.changeFilter.of(transaction => transaction.newDoc.length <= 4096), ...interaction.extensions,
      keymap.of([{ key: 'Mod-Enter', run: editor => { current.current.onRun(editor.state.doc.toString()); return true } }, ...defaultKeymap, ...historyKeymap]),
      EditorView.contentAttributes.of({ 'aria-label': 'Kafka 命令', spellcheck: 'false' }),
      EditorView.updateListener.of(update => { if (update.docChanged) current.current.onChange(update.state.doc.toString()) }),
    ], dispose: interaction.dispose }
  })
  return <div className="db-command-editor" ref={root} />
}

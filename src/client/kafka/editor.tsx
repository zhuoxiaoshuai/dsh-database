import React from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { createCompletionInteraction } from '../completion/interaction.ts'
import { hasUserTextChange, useEditorHost } from '../workspace/source/editor-host.ts'
import { createKafkaCompletionSource, type KafkaNames } from './completion.ts'

export function KafkaCommandEditor(props: { value: string; onChange(value: string): void; onRun(value: string): void; editorContext?: unknown }): React.ReactElement {
  const { root } = useEditorHost(props, current => {
    const interaction = createCompletionInteraction(createKafkaCompletionSource(() => (current.current.editorContext as KafkaNames | undefined) || { topics: [], groups: [] }))
    return { extensions: [
      history(), EditorView.lineWrapping, EditorState.changeFilter.of(transaction => transaction.newDoc.length <= 4096), ...interaction.extensions,
      keymap.of([{ key: 'Mod-Enter', run: editor => { current.current.onRun(editor.state.doc.toString()); return true } }, ...defaultKeymap, ...historyKeymap]),
      EditorView.contentAttributes.of({ 'aria-label': 'Kafka 命令', spellcheck: 'false' }),
      EditorView.updateListener.of(update => { if (hasUserTextChange(update)) current.current.onChange(update.state.doc.toString()) }),
    ], dispose: interaction.dispose }
  })
  return <div className="db-command-editor" ref={root} />
}

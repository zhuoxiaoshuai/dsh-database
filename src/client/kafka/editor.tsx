import {textEditorExtensions} from '../workspace/source/text-editor-extensions.ts'
import React from 'react'
import { EditorView } from '@codemirror/view'
import { createCompletionInteraction } from '../completion/interaction.ts'
import { hasUserTextChange, useEditorHost } from '../workspace/source/editor-host.ts'
import { createKafkaCompletionSource, type KafkaNames } from './completion.ts'

export function KafkaCommandEditor(props: { value: string; onChange(value: string): void; onRun(value: string): void; editorContext?: unknown }): React.ReactElement {
  const { root } = useEditorHost(props, current => {
    const interaction = createCompletionInteraction(createKafkaCompletionSource(() => (current.current.editorContext as KafkaNames | undefined) || { topics: [], groups: [] }))
    return { extensions: [
      ...textEditorExtensions('Kafka 命令',4096,text=>current.current.onRun(text)), ...interaction.extensions,
        EditorView.updateListener.of(update => { if (hasUserTextChange(update)) current.current.onChange(update.state.doc.toString()) }),
    ], dispose: interaction.dispose }
  })
  return <div className="db-command-editor" ref={root} />
}

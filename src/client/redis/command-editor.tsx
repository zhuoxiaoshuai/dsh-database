import React, { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { closeCompletion, completionStatus, startCompletion, type CompletionSource } from '@codemirror/autocomplete'
import { createCompletionInteraction } from '../completion/interaction.ts'
import { useEditorHost } from '../workspace/source/editor-host.ts'
import { createRedisCompletionSource, redisKeySlot, redisRemoteKeyCompletion } from './completion.ts'
import type { RedisKeySuggestResult } from '../../shared/redis-result.ts'

export function RedisCommandEditor(props: {
  value: string
  onChange(value: string): void
  onCursorChange(pos: number): void
  onRun(command: string): void
  keys?: readonly string[]
  identity?: string
  suggestKeys?(prefix: string, signal: AbortSignal): Promise<RedisKeySuggestResult>
  onKeySuggestionStatus?(status: 'loading' | 'partial' | 'complete' | 'failed'): void
}): React.ReactElement {
  const pending = useRef(new Set<AbortController>())
  const { root, view, current } = useEditorHost(props, current => {
    const remoteSource: CompletionSource = async context => {
      const live = current.current
      const slot = redisKeySlot(context.state.doc.toString(), context.pos)
      if (!slot || !live.suggestKeys || Array.from(slot.prefix).length < 2 || new TextEncoder().encode(slot.prefix).length > 128) return null
      const cached = (live.keys || []).filter(key => key.startsWith(slot.prefix))
      if (cached.length >= 30) return null
      const controller = new AbortController()
      pending.current.add(controller)
      context.addEventListener('abort', () => controller.abort(), { onDocChange: true })
      try {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 300)
          controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
        })
        if (controller.signal.aborted || context.aborted || live.identity !== current.current.identity) return null
        live.onKeySuggestionStatus?.('loading')
        const result = await live.suggestKeys(slot.prefix, controller.signal)
        if (controller.signal.aborted || context.aborted || live.identity !== current.current.identity) return null
        live.onKeySuggestionStatus?.(result.complete ? 'complete' : 'partial')
        const known = new Set((current.current.keys || []).filter(key => key.startsWith(slot.prefix)))
        return redisRemoteKeyCompletion(context.state.doc.toString(), context.pos, result.keys.filter(key => !known.has(key)).slice(0, Math.max(0, 30 - known.size)))
      } catch {
        if (!controller.signal.aborted && !context.aborted && live.identity === current.current.identity) live.onKeySuggestionStatus?.('failed')
        return null
      } finally { pending.current.delete(controller) }
    }
    const interaction = createCompletionInteraction([createRedisCompletionSource(() => current.current.keys || []), remoteSource])
    return { extensions: [
        history(), EditorView.lineWrapping, EditorState.changeFilter.of(transaction => transaction.newDoc.length <= 65536), ...interaction.extensions,
        keymap.of([
          { key: 'Mod-Enter', run: editor => { current.current.onRun(editor.state.doc.toString()); return true } },
          ...defaultKeymap, ...historyKeymap,
        ]),
        EditorView.contentAttributes.of({ 'aria-label': 'Redis 命令', 'spellcheck': 'false' }),
        EditorView.updateListener.of(update => {
          if (update.docChanged) current.current.onChange(update.state.doc.toString())
          if (update.docChanged || update.selectionSet) current.current.onCursorChange(update.state.selection.main.head)
        }),
      ], dispose: () => { for (const controller of pending.current) controller.abort(); interaction.dispose() } }
  })

  useEffect(() => {
    for (const controller of pending.current) controller.abort()
    const instance = view.current
    if (instance) closeCompletion(instance)
  }, [props.identity])

  useEffect(() => {
    const instance = view.current
    if (instance?.hasFocus && completionStatus(instance.state) && redisKeySlot(instance.state.doc.toString(), instance.state.selection.main.head)) startCompletion(instance)
  }, [props.keys])

  return <div className="db-command-editor" ref={root} />
}

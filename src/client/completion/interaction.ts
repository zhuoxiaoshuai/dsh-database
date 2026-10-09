import { Prec, type Extension } from '@codemirror/state'
import { EditorView, keymap, tooltips } from '@codemirror/view'
import { acceptCompletion, autocompletion, closeCompletion, completionStatus, moveCompletionSelection, startCompletion, type Completion, type CompletionSource } from '@codemirror/autocomplete'
import { isHostDark } from '../workspace/parts/host-theme.ts'

function guardCompletionKey(run: (view: EditorView) => boolean) {
  return (view: EditorView) => {
    if (view.composing) return false
    return run(view)
  }
}

/** The editor owns this interaction and must dispose it when destroyed. */
export function createCompletionInteraction(source: CompletionSource | readonly CompletionSource[], options: {
  onClose?(view: EditorView): void
  activateOnCompletion?: (completion: Completion) => boolean
} = {}): { extensions: Extension[]; dispose(): void } {
  let tooltipPointer = false
  const onPointer = (event: MouseEvent) => {
    const target = event.target
    tooltipPointer = target instanceof Element && !!target.closest('.cm-tooltip-autocomplete')
  }
  document.addEventListener('mousedown', onPointer, true)

  return {
    extensions: [
      tooltips({ parent: document.body }),
      autocompletion({
        override: typeof source === 'function' ? [source] : source,
        activateOnTyping: true,
        defaultKeymap: false,
        closeOnBlur: false,
        interactionDelay: 0,
        activateOnCompletion: options.activateOnCompletion,
        tooltipClass: () => isHostDark() ? 'db-dark' : '',
      }),
      Prec.highest(keymap.of([
        { key: 'Ctrl-Shift-Space', run: view => completionStatus(view.state) === 'active' || startCompletion(view) },
        { mac: 'Alt-`', run: view => completionStatus(view.state) === 'active' || startCompletion(view) },
        { mac: 'Alt-i', run: view => completionStatus(view.state) === 'active' || startCompletion(view) },
        { key: 'Escape', run: guardCompletionKey(view => { options.onClose?.(view); return closeCompletion(view) }) },
        { key: 'ArrowDown', run: guardCompletionKey(moveCompletionSelection(true)) },
        { key: 'ArrowUp', run: guardCompletionKey(moveCompletionSelection(false)) },
        { key: 'PageDown', run: guardCompletionKey(moveCompletionSelection(true, 'page')) },
        { key: 'PageUp', run: guardCompletionKey(moveCompletionSelection(false, 'page')) },
        { key: 'Enter', run: guardCompletionKey(acceptCompletion) },
      ])),
      EditorView.domEventHandlers({
        blur(_event, editor) {
          if (tooltipPointer) {
            tooltipPointer = false
            return
          }
          closeCompletion(editor)
        },
      }),
    ],
    dispose() { document.removeEventListener('mousedown', onPointer, true) },
  }
}

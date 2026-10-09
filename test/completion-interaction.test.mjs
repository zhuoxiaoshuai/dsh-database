import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorState, Transaction } from '@codemirror/state'
import { history, undo } from '@codemirror/commands'
import { externalTextSync, hasUserTextChange } from '../src/client/workspace/source/editor-host.ts'
import { keymap } from '@codemirror/view'
import { startCompletion, completionStatus } from '@codemirror/autocomplete'
import { createCompletionInteraction } from '../src/client/completion/interaction.ts'

test('external editor sync neither reports user edits nor enters undo history', () => {
  let state = EditorState.create({ doc: 'initial', extensions: history() })
  const remote = state.update({ changes: { from: 0, to: state.doc.length, insert: 'AI query' }, annotations: [externalTextSync.of(true), Transaction.addToHistory.of(false)] })
  assert.equal(hasUserTextChange({ transactions: [remote] }), false)
  state = remote.state
  const typed = state.update({ changes: { from: state.doc.length, insert: '!' } })
  assert.equal(hasUserTextChange({ transactions: [typed] }), true)
  state = typed.state
  const target = { get state() { return state }, dispatch(transaction) { assert.equal(hasUserTextChange({ transactions: [transaction] }), true); state = transaction.state } }
  assert.equal(undo(target), true)
  assert.equal(state.doc.toString(), 'AI query')
  assert.equal(undo(target), false)
})

test('shared completion interaction attaches and removes its tooltip pointer listener', () => {
  const original = globalThis.document
  const listeners = new Map()
  globalThis.document = {
    body: {},
    addEventListener(name, listener, capture) { assert.equal(capture, true); listeners.set(name, listener) },
    removeEventListener(name, listener, capture) { assert.equal(capture, true); assert.equal(listeners.get(name), listener); listeners.delete(name) },
  }
  try {
    const interaction = createCompletionInteraction(() => null)
    assert.ok(interaction.extensions.length >= 3)
    assert.ok(listeners.has('mousedown'))
    interaction.dispose()
    assert.equal(listeners.size, 0)
  } finally {
    globalThis.document = original
  }
})


test('pending completion has no usable selection and must not consume arrows or Enter, including IME', () => {
  const original = globalThis.document
  globalThis.document = { body: {}, addEventListener() {}, removeEventListener() {} }
  try {
    const interaction = createCompletionInteraction(() => null)
    const view = { composing: false, state: EditorState.create({ extensions: interaction.extensions }), dispatch(spec) { this.state = this.state.update(spec).state } }
    startCompletion(view)
    assert.equal(completionStatus(view.state), 'pending')
    const bindings = view.state.facet(keymap).flat()
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) {
      assert.equal(bindings.find(binding => binding.key === key).run(view), false)
      view.composing = true; assert.equal(bindings.find(binding => binding.key === key).run(view), false); view.composing = false
    }
    interaction.dispose()
  } finally { globalThis.document = original }
})

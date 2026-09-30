import test from 'node:test'
import assert from 'node:assert/strict'
import { createCompletionInteraction } from '../src/client/completion/interaction.ts'

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

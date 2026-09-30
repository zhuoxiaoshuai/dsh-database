import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldDismissBackdrop } from '../src/client/workspace/parts/dialog.ts'

test('backdrop click closes only when the press started on the dimmed area', () => {
  const overlay = { id: 'overlay' }
  const input = { id: 'input' }
  assert.equal(shouldDismissBackdrop(true, overlay, overlay), true)
  assert.equal(shouldDismissBackdrop(false, overlay, overlay), false)
  assert.equal(shouldDismissBackdrop(true, input, overlay), false)
  assert.equal(shouldDismissBackdrop(false, input, overlay), false)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { clampSplitRatio, ratioAfterDrag, splitGridRows } from '../src/client/sql-pane-layout.ts'

test('SQL split ratio reserves visible space for both panes', () => {
  assert.equal(clampSplitRatio(0.95, 400), 0.26)
  assert.equal(clampSplitRatio(0.05, 400), 66 / 400)
  assert.equal(clampSplitRatio(0.6, 120), 66 / 362)
})

test('SQL split drag uses only the split tracks, not toolbar height', () => {
  assert.equal(ratioAfterDrag(0.5, 250, 514), 1 - 296 / 500)
  assert.equal(ratioAfterDrag(0.5, -250, 514), 66 / 500)
})

test('SQL split rows cover expanded and collapsed states', () => {
  assert.equal(splitGridRows(true, true, 0.6, 514), '204px 14px minmax(0,1fr)')
  assert.equal(splitGridRows(true, false, 0.6, 514), 'minmax(0,1fr) 14px')
  assert.equal(splitGridRows(false, true, 0.6, 514), '14px minmax(0,1fr)')
  assert.equal(splitGridRows(true, true, 0.6, 0), '0.6fr 14px 0.4fr')
})

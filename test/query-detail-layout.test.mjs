import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { applyDockDrag, dockMaxHeight, DOCK_MIN_HEIGHT, GRID_RESERVE } from '../src/client/query-detail-layout.ts'
import { SQL_EDITOR_MIN, stealEditorPixels } from '../src/client/sql-pane-layout.ts'

test('opening the dock fills the grid except header plus three rows', () => {
  assert.equal(GRID_RESERVE, 112)
  assert.equal(dockMaxHeight(400), 288)
  assert.equal(dockMaxHeight(80), 0)
})

test('dragging the dock up first eats leftover grid then asks to steal the editor', () => {
  const inside = applyDockDrag({ startHeight: 120, startGridHeight: 400, deltaY: 50 })
  assert.equal(inside.height, 170)
  assert.equal(inside.stealPx, 0)
  assert.equal(inside.pinToMax, false)

  const toMax = applyDockDrag({ startHeight: 200, startGridHeight: 400, deltaY: 200 })
  assert.equal(toMax.height, 288)
  assert.equal(toMax.stealPx, 112)
  assert.equal(toMax.pinToMax, true)

  const afterSteal = applyDockDrag({ startHeight: 200, startGridHeight: 400, currentGridHeight: 484, deltaY: 200 })
  assert.equal(afterSteal.height, 372)
  assert.equal(afterSteal.stealPx, 112)
})

test('dragging the dock down only shrinks the dock', () => {
  const down = applyDockDrag({ startHeight: 316, startGridHeight: 400, deltaY: -80 })
  assert.equal(down.height, 236)
  assert.equal(down.stealPx, 0)
  assert.equal(down.pinToMax, false)
  const floor = applyDockDrag({ startHeight: 130, startGridHeight: 400, deltaY: -40 })
  assert.equal(floor.height, DOCK_MIN_HEIGHT)
  assert.equal(floor.stealPx, 0)
})

test('stealing editor pixels stops at three editor lines', () => {
  assert.equal(SQL_EDITOR_MIN, 66)
  const { stolen, ratio } = stealEditorPixels(0.6, 514, 400)
  assert.equal(ratio, 66 / 500)
  assert.ok(Math.abs(stolen - (204 - 66)) < 0.0001)
  assert.equal(stealEditorPixels(ratio, 514, 80).stolen, 0)
})

test('detail head keeps a compact search field on the same row', () => {
  const css = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8')
  const viewer = readFileSync(new URL('../src/client/cell-detail-viewer.tsx', import.meta.url), 'utf8')
  assert.match(viewer, /db-cell-detail-head[\s\S]*db-cell-detail-search[\s\S]*db-cell-detail-actions/)
  assert.doesNotMatch(viewer, /<\/header>\s*<input className="db-cell-detail-search"/)
  const search = css.match(/\.db-workbench \.db-cell-detail-search\{[^}]+\}/)?.[0] || ''
  assert.match(search, /width:11em/)
  assert.match(search, /flex:none/)
})

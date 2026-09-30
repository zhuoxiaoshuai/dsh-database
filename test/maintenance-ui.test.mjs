import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('maintenance reason button is bounded, ellipsized and exposes full title', () => {
  const css = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8')
  const component = readFileSync(new URL('../src/client/maintenance-toggle.tsx', import.meta.url), 'utf8')
  assert.match(css, /\.db-maintenance-toggle-wrap\{[^}]*max-width:168px/)
  assert.match(css, /\.db-workbench \.db-maintenance-toggle\{[^}]*text-overflow:ellipsis/)
  assert.match(component, /title=\{!checking && !usable \? reason/)
  assert.match(component, /onReason\(reason\)/)
})

test('maintenance action buttons share the compact button class', () => {
  const css = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8')
  const objectPage = readFileSync(new URL('../src/client/object-workspace.tsx', import.meta.url), 'utf8')
  const queryPage = readFileSync(new URL('../src/client/sql-workspace-tab.tsx', import.meta.url), 'utf8')
  assert.match(css, /\.db-workbench \.db-maintenance-small\{height:24px/)
  for (const label of ['新增', '删除', '保存']) {
    assert.match(objectPage, new RegExp(`db-maintenance-small[^>]*[\\s\\S]{0,200}>${label}`))
    assert.match(queryPage, new RegExp(`db-maintenance-small[^>]*[\\s\\S]{0,200}>${label}`))
  }
})

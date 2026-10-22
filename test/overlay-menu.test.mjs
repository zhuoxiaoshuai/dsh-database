import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { defaultThemeCss } from '../src/client/workspace/parts/theme-tokens.ts'

const css = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8')
test('overlay menus and autocomplete consume the shared semantic palette', () => {
  for (const selector of ['.db-search-select-menu', '.cm-tooltip.cm-tooltip-autocomplete']) {
    const block = css.match(new RegExp(selector.replaceAll('.', '\\.').replaceAll('-', '\\-') + '\\{[^}]+\\}'))?.[0] || ''
    assert.match(block, /color:var\(--db-text\)/)
    assert.doesNotMatch(block, /--db-(panel|text|accent):/)
  }
  assert.match(css, /background:var\(--db-overlay-panel\)/)
  assert.match(css, /border-radius:var\(--db-radius-overlay\)/)
  assert.match(css, /\.cm-tooltip\.cm-tooltip-autocomplete>ul>li\[aria-selected\]\{[^}]*background:var\(--db-tint\) !important/)
  assert.match(css, /\.cm-completionIcon-keyword:after\{content:"词" !important\}/)
})
test('isolated previews retain shared light and legacy host-dark defaults', () => {
  const defaults = defaultThemeCss()
  assert.match(defaults, /body\[data-ds-dark-theme\] \.db-workbench/)
  assert.match(defaults, /body\[data-ds-dark-theme\] \.db-search-select-menu/)
  assert.match(defaults, /body\[data-ds-dark-theme\] \.cm-tooltip\.cm-tooltip-autocomplete/)
  assert.match(css, /\.db-workbench \.db-primary\{background:var\(--db-accent\)/)
  assert.match(css, /-webkit-text-fill-color:var\(--db-on-accent\)/)
  assert.match(css, /\.db-workbench \.db-conn-tree \.db-tree-icon-table\{color:var\(--db-info\)\}/)
})

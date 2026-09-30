import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('overlay menus inherit DSH tokens with light fallbacks', () => {
  const css = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8')
  const block = css.match(/\.db-search-select-menu\{[^}]+\}/)?.[0] || ''
  assert.match(block, /--db-text:var\(--dsw-alias-label-primary,#283546\)/)
  assert.match(block, /color:var\(--db-text\)/)
  assert.doesNotMatch(block, /color:#283546/)
  assert.match(css, /\.db-search-select-menu>button\{[^}]*-webkit-text-fill-color:currentColor/)
  assert.match(css, /body\[data-ds-dark-theme\] \.db-search-select-menu/)
})

test('sql autocomplete tooltip matches overlay menu tokens', () => {
  const css = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8')
  const block = css.match(/\.cm-tooltip\.cm-tooltip-autocomplete\{[^}]+\}/)?.[0] || ''
  assert.match(block, /--db-text:var\(--dsw-alias-label-primary,#283546\)/)
  assert.match(block, /background:var\(--db-panel\) !important/)
  assert.match(block, /border-radius:8px/)
  assert.doesNotMatch(block, /background:#f5f5f5/)
  assert.match(css, /body\[data-ds-dark-theme\] \.cm-tooltip\.cm-tooltip-autocomplete/)
  assert.match(css, /\.cm-tooltip\.cm-tooltip-autocomplete>ul>li\[aria-selected\]\{[^}]*background:var\(--db-tint\) !important/)
  assert.match(css, /\.cm-completionIcon-keyword:after\{content:"词" !important\}/)
})

test('workbench palette bridges to DSH alias tokens', () => {
  const css = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8')
  assert.match(css, /--db-bg:var\(--dsw-alias-bg-base,#f6f8fa\)/)
  assert.match(css, /--db-accent:#148476/)
  assert.doesNotMatch(css, /--db-accent:var\(--dsw-alias-brand-primary/)
  assert.match(css, /--db-on-accent:#fff/)
  assert.match(css, /\.db-workbench \.db-primary\{background:var\(--db-accent\)/)
  assert.match(css, /\.db-workbench button\.db-primary\{color:var\(--db-on-accent\);-webkit-text-fill-color:var\(--db-on-accent\)\}/)
  assert.match(css, /color-scheme:inherit/)
  assert.match(css, /body\[data-ds-dark-theme\] \.db-workbench/)
  assert.match(css, /\.db-workbench input:not\(\[type=checkbox\]\),\.db-workbench select\{[^}]*-webkit-text-fill-color:var\(--db-text\)/)
  assert.match(css, /\.db-workbench \.db-conn-tree \.db-tree-icon-table\{color:#3b82c4\}/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { isHostDark, HOST_DARK_ATTRIBUTE } from '../src/client/workspace/parts/host-theme.ts'
import { overlayMenuClass } from '../src/client/workspace/parts/overlay-menu.ts'

test('host dark follows body[data-ds-dark-theme] before html class', () => {
  assert.equal(isHostDark({ body: { hasAttribute: name => name === HOST_DARK_ATTRIBUTE } }), true)
  assert.equal(isHostDark({
    documentElement: { classList: { contains: () => false }, dataset: {}, style: { colorScheme: 'light' } },
    body: { hasAttribute: () => false },
  }), false)
})

test('host dark accepts html.dark, data-theme, and color-scheme', () => {
  assert.equal(isHostDark({ documentElement: { classList: { contains: name => name === 'dark' }, dataset: {}, style: {} }, body: { hasAttribute: () => false } }), true)
  assert.equal(isHostDark({ documentElement: { classList: { contains: () => false }, dataset: { theme: 'dark' }, style: {} }, body: { hasAttribute: () => false } }), true)
  assert.equal(isHostDark({ documentElement: { classList: { contains: () => false }, dataset: {}, style: { colorScheme: 'dark' } }, body: { hasAttribute: () => false } }), true)
  assert.equal(isHostDark({ documentElement: { classList: { contains: () => false }, dataset: {}, style: { colorScheme: 'light' } }, body: { hasAttribute: () => false } }), false)
})

test('prefers-color-scheme is last resort when host has no explicit scheme', () => {
  assert.equal(isHostDark({
    documentElement: { classList: { contains: () => false }, dataset: {}, style: {} },
    body: { hasAttribute: () => false },
    defaultView: { matchMedia: () => ({ matches: true }) },
  }), true)
  assert.equal(isHostDark({
    documentElement: { classList: { contains: () => false }, dataset: {}, style: { colorScheme: 'light' } },
    body: { hasAttribute: () => false },
    defaultView: { matchMedia: () => ({ matches: true }) },
  }), false)
})

test('overlay menu class follows workbench or host body dark', () => {
  const light = { closest: () => ({ classList: { contains: () => false } }) }
  const dark = { closest: () => ({ classList: { contains: name => name === 'db-dark' } }) }
  assert.equal(overlayMenuClass(light, '', { body: { hasAttribute: () => false }, documentElement: { classList: { contains: () => false }, dataset: {}, style: { colorScheme: 'light' } } }), 'db-search-select-menu')
  assert.equal(overlayMenuClass(dark, 'db-template-picker-menu', { body: { hasAttribute: () => false } }), 'db-search-select-menu db-dark db-template-picker-menu')
  assert.equal(overlayMenuClass(null, '', { body: { hasAttribute: name => name === HOST_DARK_ATTRIBUTE } }), 'db-search-select-menu db-dark')
  assert.equal(overlayMenuClass(null, '', { body: { hasAttribute: () => false }, documentElement: { classList: { contains: () => false }, dataset: {}, style: { colorScheme: 'light' } } }), 'db-search-select-menu')
})

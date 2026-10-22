import test from 'node:test'
import assert from 'node:assert/strict'
import { isHostDark } from '../src/client/workspace/parts/host-theme.ts'
import { themeVariables, workbenchThemes } from '../src/client/workspace/parts/theme-tokens.ts'

test('explicit host light defeats system dark and stale dark class', () => {
  assert.equal(isHostDark({ documentElement: { dataset: { theme: 'light' }, classList: { contains: name => name === 'dark' } }, defaultView: { matchMedia: () => ({ matches: true }) } }), false)
  assert.equal(isHostDark({ documentElement: {}, defaultView: { getComputedStyle: () => ({ colorScheme: 'light' }), matchMedia: () => ({ matches: true }) } }), false)
  assert.equal(isHostDark({ documentElement: { style: { colorScheme: 'light dark' } }, defaultView: { matchMedia: () => ({ matches: false }) } }), false)
})

let sequence = 0
async function fresh(storage, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } })
  try { await run(await import(`../src/client/workspace/parts/workbench-theme.ts?theme-test=${++sequence}`)) }
  finally { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window }
}

test('saved preference restores and explicit modes override host; updates reach all subscribers', async () => {
  let saved = JSON.stringify({ version: 1, preference: { paletteId: 'mist-green', mode: 'dark' } })
  await fresh({ getItem: () => saved, setItem: (_, value) => { saved = value } }, async theme => {
    assert.equal(theme.resolveWorkbenchTheme({ documentElement: { dataset: { theme: 'light' } } }).scheme, 'dark')
    let first = 0, second = 0
    const stopFirst = theme.subscribeWorkbenchTheme(() => first++)
    const stopSecond = theme.subscribeWorkbenchTheme(() => second++)
    theme.setWorkbenchTheme({ paletteId: 'mist-green', mode: 'light' })
    assert.equal(theme.resolveWorkbenchTheme({ body: { hasAttribute: () => true } }).scheme, 'light')
    assert.deepEqual([first, second], [1, 1])
    assert.equal(JSON.parse(saved).preference.mode, 'light')
    stopFirst(); theme.setWorkbenchTheme({ paletteId: 'mist-green', mode: 'host' })
    assert.deepEqual([first, second], [1, 2])
    stopSecond()
  })
})

test('invalid, old and malformed saved preferences safely fall back', async () => {
  for (const saved of ['{', JSON.stringify({ version: 0, preference: { paletteId: 'mist-green', mode: 'dark' } }), JSON.stringify({ version: 1, preference: { paletteId: 'removed-theme', mode: 'dark' } })]) {
    await fresh({ getItem: () => saved, setItem() {} }, async theme => {
      assert.deepEqual(theme.getWorkbenchThemePreference(), { paletteId: 'mist-green', mode: 'host' })
    })
  }
})

test('blocked storage preserves a usable in-memory theme without throwing', async () => {
  await fresh({ getItem() { throw Error('blocked') }, setItem() { throw Error('blocked') } }, async theme => {
    theme.setWorkbenchTheme({ paletteId: 'mist-green', mode: 'dark' })
    assert.equal(theme.resolveWorkbenchTheme().scheme, 'dark')
    theme.setWorkbenchTheme({ paletteId: 'constructor', mode: 'dark' })
    assert.deepEqual(theme.getWorkbenchThemePreference(), { paletteId: 'mist-green', mode: 'host' })
  })
})

function luminance(hex) {
  const [r,g,b] = hex.slice(1).match(/../g).map(value => parseInt(value,16)/255).map(value => value <= .04045 ? value/12.92 : ((value+.055)/1.055)**2.4)
  return .2126*r+.7152*g+.0722*b
}
function contrast(a,b) { const x=luminance(a),y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05) }
test('both schemes supply identical tokens and readable text/button states', () => {
  const light = themeVariables('mist-green', 'light'), dark = themeVariables('mist-green', 'dark')
  assert.deepEqual(Object.keys(light).sort(), Object.keys(dark).sort())
  for (const palette of [light,dark]) {
    for (const text of ['--db-text','--db-muted','--db-placeholder','--db-error','--db-warn','--db-info']) {
      for (const bg of ['--db-panel','--db-nav','--db-overlay-panel']) assert.ok(contrast(palette[text],palette[bg]) >= 4.5, `${text}/${bg}`)
    }
    for (const state of ['--db-accent','--db-accent-hover','--db-accent-active']) assert.ok(contrast(palette['--db-on-accent'],palette[state]) >= 4.5, state)
    assert.ok(contrast(palette['--db-on-danger'],palette['--db-error']) >= 4.5)
  }
  assert.deepEqual(themeVariables('constructor','light'),light)
})

test('a complete registered palette switches geometry, editor, state and overlay tokens through one preference', async () => {
  const base = workbenchThemes['mist-green']
  workbenchThemes['test-palette'] = { name: 'Test only', shared: { ...base.shared, '--db-radius-control': '9px' }, light: { ...base.light, '--db-panel': '#FEFEFE', '--db-sql-keyword': '#654321', '--db-overlay-panel': '#FDFDFD' }, dark: { ...base.dark } }
  try {
    await fresh({ getItem: () => null, setItem() {} }, async theme => {
      theme.setWorkbenchTheme({ paletteId: 'test-palette', mode: 'light' })
      const value = theme.resolveWorkbenchTheme().variables
      assert.equal(value['--db-radius-control'],'9px')
      assert.equal(value['--db-panel'],'#FEFEFE')
      assert.equal(value['--db-sql-keyword'],'#654321')
      assert.equal(value['--db-overlay-panel'],'#FDFDFD')
    })
  } finally { delete workbenchThemes['test-palette'] }
})

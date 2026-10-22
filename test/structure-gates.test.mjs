import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = path => readFileSync(join(root, path), 'utf8')
function walk(dir, extensions) {
  const out = []
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...walk(path, extensions))
    else if (extensions.some(extension => entry.name.endsWith(extension))) out.push(path)
  }
  return out
}

/** Files removed by the D0-D3 cleanup must not come back. */
const REMOVED = [
  'src/host/data-sources/runtime-registry.mjs',
  'src/host/data-sources/types.mjs',
  'src/host/oracle-temporal.mjs',
  'src/connection-service.ts',
  'src/client/search-select.tsx',
  'src/client/workspace/parts/action-menu.tsx',
  'src/client/workspace/parts/dialog-frame.tsx',
  'src/client/workspace/parts/dialog.ts',
  'src/client/workspace/parts/host-theme.ts',
  'src/client/workspace/parts/resource-list.tsx',
  'src/client/workspace/parts/theme-tokens.ts',
  'src/client/workspace/parts/use-drag-resize.ts',
  'src/client/workspace/parts/use-drawer-focus.ts',
  'src/client/workspace/parts/use-panel-size.ts',
  'src/client/workspace/parts/use-workbench-theme.ts',
  'src/client/workspace/parts/workbench-theme.ts',
  'src/client/workspace/parts/feedback/resource-list.tsx',
  'src/client/workspace/source/editor-host.ts',
  'src/client/workspace/source/editor-theme.ts',
  'src/client/workspace/source/query-result-frame.tsx',
  'src/client/workspace/source/text-editor-extensions.ts',
  'src/client/workspace/source/workspace-tabs.tsx',
]

/** Retained on purpose: build path mirrors and the client/Host boundary. */
const RETAINED = [
  'src/host/shared/connection-permission.mjs',
  'src/host/shared/limits.mjs',
  'src/shared/connection-permission.ts',
  'src/shared/limits.ts',
  'src/shared/primary-keys.ts',
]

test('removed compatibility aliases stay removed and retained facades stay', () => {
  for (const path of REMOVED) assert.equal(existsSync(join(root, path)), false, `${path} must not return`)
  for (const path of RETAINED) assert.equal(existsSync(join(root, path)), true, `${path} is a required facade`)
})

test('client workspace has no compatibility re-export shims', () => {
  const shim = /^\s*export\s+(?:\*|\{[^}]*\}|type\s+\{[^}]*\})\s+from\s+['"][^'"]+['"];?\s*$/
  for (const path of walk('src/client', ['.ts', '.tsx'])) {
    const lines = read(path).split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//') && !line.startsWith('/*') && !line.startsWith('*'))
    assert.ok(!lines.length || !lines.every(line => shim.test(line)), `${path} is a compatibility re-export shim`)
  }
})

test('host policy delegates SQL splitting to the shared lexer', () => {
  const policy = read('src/host/data-sources/sql-policy-common.mjs')
  assert.match(policy, /import \{ splitStatements \} from '\.\.\/\.\.\/shared\/sql-lex\.ts'/)
  assert.doesNotMatch(policy, /export function splitStatements/)
  assert.match(read('src/shared/sql-lex.ts'), /export function splitStatements/)
})

test('standalone entries share direct-run detection', () => {
  for (const path of ['src/launch.ts', 'src/serve.ts']) {
    const source = read(path)
    assert.doesNotMatch(source, /function isDirectRun/, `${path} must use the shared helper`)
    assert.match(source, /isDirectRun\(import\.meta\.url\)/, `${path} must compare its own entry`)
  }
})

test('client code never imports the host', () => {
  const hostImport = /from ['"](?:\.{1,2}\/)+host(?:\/[^'"]*)?['"]/
  for (const path of walk('src/client', ['.ts', '.tsx'])) {
    assert.doesNotMatch(read(path), hostImport, `${path} imports the host`)
  }
})

test('package exports stay the three public entries', () => {
  assert.deepEqual(Object.keys(JSON.parse(read('package.json')).exports), ['.', './client', './package.json'])
})

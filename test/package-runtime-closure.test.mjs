import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

test('published package includes every copied host module imported at runtime', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const build = readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf8')
  const shipped = path => pkg.files.some(entry => entry === path || path.startsWith(entry.replace(/\/?$/, '/')))
  const hostCopyLoop = build.match(/for \(const file of \[([^\]]+)\]\) \{\s*await copyFile\('src\/host\/'/)
  assert.ok(hostCopyLoop, 'build.mjs host copy loop not found')
  const copiedHostModules = [...hostCopyLoop[1].matchAll(/'([a-z][a-z-]+\.mjs)'/g)].map(match => match[1])

  for (const module of copiedHostModules) {
    const source = readFileSync(new URL(`../src/host/${module}`, import.meta.url), 'utf8')
    assert.ok(shipped(`lib/${module}`), `package.json omits lib/${module}`)
    for (const match of source.matchAll(/from\s+['"]\.\/([a-z][a-z-]+\.mjs)['"]/g)) {
      const dependency = match[1]
      assert.ok(copiedHostModules.includes(dependency), `${module} imports ${dependency}, but build.mjs does not copy it`)
      assert.ok(shipped(`lib/${dependency}`), `${module} imports ${dependency}, but package.json does not ship it`)
    }
  }
})

test('isolated provider tree is copied and every relative runtime import is shipped', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const build = readFileSync(resolve(root, 'scripts/build.mjs'), 'utf8')
  assert.match(build, /copyTree\('src\/host\/data-sources', 'lib\/data-sources'\)/)
  assert.ok(pkg.files.includes('lib/data-sources'))
  const copiedHost = new Set([...build.matchAll(/'([a-z][a-z-]+\.mjs)'/g)].map(match => match[1]))
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(dir, entry.name)
    return entry.isDirectory() ? walk(path) : entry.name.endsWith('.mjs') ? [path] : []
  })
  for (const source of walk(resolve(root, 'src/host/data-sources'))) {
    const code = readFileSync(source, 'utf8')
    for (const match of code.matchAll(/(?:from\s*|import\()\s*['"](\.{1,2}\/[^'"]+\.mjs)['"]/g)) {
      const dependency = resolve(dirname(source), match[1])
      assert.ok(existsSync(dependency), `${source} imports missing ${match[1]}`)
      const modulePath = relative(resolve(root, 'src/host'), dependency).replaceAll('\\', '/')
      if (!modulePath.startsWith('data-sources/')) assert.ok(copiedHost.has(modulePath), `${modulePath} is not in the host copy list`)
    }
  }
})

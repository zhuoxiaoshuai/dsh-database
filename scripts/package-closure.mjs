import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, posix } from 'node:path'
import { spawnSync } from 'node:child_process'

const npmCli = process.env.npm_execpath
const command = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm'
const packed = spawnSync(command, [...(npmCli ? [npmCli] : []), 'pack', '--dry-run', '--json', '--ignore-scripts', '--cache', '.npm-cache'], {
  cwd: new URL('../', import.meta.url),
  encoding: 'utf8',
  shell: process.platform === 'win32' && !npmCli,
  maxBuffer: 8 * 1024 * 1024
})
if (packed.status !== 0) throw new Error(`npm pack --dry-run failed: ${packed.stderr}`)
const manifest = JSON.parse(packed.stdout)[0]
const files = new Set(manifest.files.map(file => file.path))
for (const required of ['lib/index.js', 'lib/client.js', 'lib/kafka-worker.mjs', 'lib/data-sources/kafka/driver.mjs']) {
  assert.ok(files.has(required), `published tarball is missing ${required}`)
}
for (const path of files) {
  assert.doesNotMatch(path, /(?:^|\/)(?:test|fixtures)(?:\/|$)|source-module-worker/, `test fixture shipped: ${path}`)
  if (!path.startsWith('lib/') || !/\.(?:mjs|js)$/.test(path)) continue
  const code = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  assert.doesNotMatch(code, /mock-source|source-module-(?:host|client|worker)|test-only-source|模拟读取完成/, `test source leaked into ${path}`)
  for (const match of code.matchAll(/(?:from\s*|import\()\s*['"](\.{1,2}\/[^'"]+\.mjs)['"]/g)) {
    const dependency = posix.normalize(posix.join(dirname(path).replaceAll('\\', '/'), match[1]))
    assert.ok(files.has(dependency), `${path} imports ${dependency}, which is absent from the tarball`)
  }
}
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(pkg.dependencies.kafkajs, '2.2.4')
assert.doesNotMatch(readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8'), /from ["']kafkajs["']/)
assert.doesNotMatch(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), /from ["']kafkajs["']/)
console.log(JSON.stringify({ files: files.size, bytes: manifest.size, kafkaWorker: true, relativeImports: 'PASS' }))

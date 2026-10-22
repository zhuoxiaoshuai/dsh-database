import { build } from 'esbuild'
import { readFile, writeFile, mkdir, copyFile, readdir, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve, sep } from 'node:path'
import { builtinModules } from 'node:module'
const generated = spawnSync(process.execPath, ['scripts/gen-database-css.cjs'], { stdio: 'inherit' })
if (generated.status !== 0) process.exit(generated.status ?? 1)
await mkdir('lib/preview', { recursive: true })
await mkdir('lib/shared', { recursive: true })
await mkdir('lib/dialects', { recursive: true })
async function copyTree(from, to) {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyTree(`${from}/${entry.name}`, `${to}/${entry.name}`)
    else if (entry.isFile() && entry.name.endsWith('.mjs')) await copyFile(`${from}/${entry.name}`, `${to}/${entry.name}`)
  }
}
const css = await readFile('src/client/theme.css', 'utf8') + (await readFile('src/client/style.css', 'utf8')).replace("@import './theme.css';", '')
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
function verifyStandaloneDependencies(result) {
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) {
      const name = imported.path
      if (!imported.external || name.startsWith('.') || name.startsWith('node:') || builtinModules.includes(name)) continue
      const dependency = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]
      if (!pkg.dependencies?.[dependency]) throw new Error(`Standalone runtime import must be a production dependency: ${dependency}`)
    }
  }
}
await build({ entryPoints: ['src/index.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: 'lib/index.js', define: { __PLUGIN_VERSION__: JSON.stringify(pkg.version) } })
// Database drivers belong to source workers, not the always-loaded Host entry.
if (/\b(?:from|require\()\s*['"](?:redis|mysql2(?:\/[^'"]*)?|oracledb|kafkajs)['"]/.test(await readFile('lib/index.js', 'utf8'))) throw new Error('Database driver leaked into Host entry')
for (const file of ['redis-worker.mjs', 'kafka-worker.mjs', 'connection-worker.mjs', 'connect-error.mjs', 'connection-failure.mjs', 'catalog.mjs', 'query.mjs', 'query-pool.mjs', 'session-manager.mjs', 'query-policy.mjs', 'browse.mjs', 'maintenance.mjs', 'maintenance-capability.mjs', 'dml-plan.mjs', 'ddl-plan.mjs', 'primary-keys.mjs', 'oracle-temporal.mjs', 'request-timeouts.mjs', 'cell-value.mjs']) {
  await copyFile('src/host/' + file, 'lib/' + file)
}
await rm('lib/dialects', { recursive: true, force: true })
await mkdir('lib/dialects', { recursive: true })
for (const file of ['registry.mjs']) {
  await copyFile('src/host/dialects/' + file, 'lib/dialects/' + file)
}
const providerOutput = resolve('lib/data-sources'), libRoot = resolve('lib')
if (!providerOutput.startsWith(libRoot + sep)) throw new Error('Provider output is outside lib')
await rm(providerOutput, { recursive: true, force: true })
await copyTree('src/host/data-sources', 'lib/data-sources')
// Inline the shared browser/Host codec at its existing Worker import path.
await build({entryPoints:['src/host/data-sources/kafka/command.mjs'],bundle:true,platform:'node',format:'esm',outfile:'lib/data-sources/kafka/command.mjs'})
await build({entryPoints:['src/host/data-sources/nacos/http-client.mjs'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:'lib/data-sources/nacos/http-client.mjs'})
// Provider output omits src/host: bundle shared source imports rather than copying escaping paths.
for(const file of ['configuration-service.mjs','config-protection.mjs','markup-protection.mjs'])await build({entryPoints:['src/host/data-sources/nacos/'+file],bundle:true,platform:'node',format:'esm',packages:'external',outfile:'lib/data-sources/nacos/'+file})
await copyFile('src/shared/connection-permission.mjs', 'lib/shared/connection-permission.mjs')
await copyFile('src/shared/limits.mjs', 'lib/shared/limits.mjs')
// A raw copy of nacos-worker.mjs cannot import src/shared from lib/. Bundle the HTTP client and endpoint helpers into the worker.
await build({ entryPoints: ['src/host/nacos-worker.mjs'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: 'lib/nacos-worker.mjs' })
if (/\.\.\/shared\//.test(await readFile('lib/nacos-worker.mjs', 'utf8'))) throw new Error('Nacos worker import escaped the package')
await build({ entryPoints: ['src/client/index.tsx'], bundle: true, platform: 'browser', format: 'cjs', external: ['react', 'react-dom', 'react/jsx-runtime'], outfile: 'lib/client.js', loader: { '.png': 'dataurl' } })
const client = await readFile('lib/client.js', 'utf8')
await writeFile('lib/client.js', `window.__ModuleLoader__.load({id:"dsh-database",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${client}\nreturn module.exports;}});\n`)
await build({ entryPoints: ['preview/index.tsx'], bundle: true, platform: 'browser', format: 'esm', outfile: 'lib/preview/preview.js', loader: { '.png': 'dataurl' } })
await copyFile('preview/index.html', 'lib/preview/index.html')
await writeFile('lib/preview/preview.css', css)
const standaloneAlias = { '@deepseek-ai/dsh-tools': resolve('src/standalone/dsh-tools-stub.ts') }
verifyStandaloneDependencies(await build({
  entryPoints: ['src/serve.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external',
  outfile: 'lib/serve.js', alias: standaloneAlias, banner: { js: '#!/usr/bin/env node' }, metafile: true,
}))
verifyStandaloneDependencies(await build({
  entryPoints: ['src/launch.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external',
  outfile: 'lib/launch.js', alias: standaloneAlias, banner: { js: '#!/usr/bin/env node' },
  plugins: [{ name: 'external-serve', setup(b) { b.onResolve({ filter: /^\.\/serve\.ts$/ }, () => ({ path: './serve.js', external: true })) } }], metafile: true,
}))
const serveCode = await readFile('lib/serve.js', 'utf8')
if (/\b(?:from|require\()\s*['"](?:redis|mysql2(?:\/[^'"]*)?|oracledb|kafkajs)['"]/.test(serveCode)) throw new Error('Database driver leaked into standalone entry')
if (serveCode.includes('@deepseek-ai/dsh-tools')) throw new Error('Standalone entry depends on DSH tools')
if (serveCode.includes('registerDatabase')) throw new Error('Standalone entry calls plugin registration')
// The shipped host/client must not contain preview fixture data.
if ((await readFile('lib/client.js', 'utf8')).includes('ORD-20260912-')) throw new Error('Preview fixture leaked into host client')
console.log('Built host ESM, DSH client factory, isolated preview and standalone server.')

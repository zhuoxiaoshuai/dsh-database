import { build } from 'esbuild'
import { readFile, writeFile, mkdir, copyFile, readdir, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve, sep } from 'node:path'
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
const css = await readFile('src/client/style.css', 'utf8')
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
await build({ entryPoints: ['src/index.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: 'lib/index.js', define: { __PLUGIN_VERSION__: JSON.stringify(pkg.version) } })
// Database drivers belong to source workers, not the always-loaded Host entry.
if (/\b(?:from|require\()\s*['"](?:redis|mysql2(?:\/[^'"]*)?|oracledb|kafkajs)['"]/.test(await readFile('lib/index.js', 'utf8'))) throw new Error('Database driver leaked into Host entry')
for (const file of ['redis-worker.mjs', 'kafka-worker.mjs', 'connection-worker.mjs', 'connect-error.mjs', 'catalog.mjs', 'query.mjs', 'query-pool.mjs', 'session-manager.mjs', 'query-policy.mjs', 'browse.mjs', 'maintenance.mjs', 'maintenance-capability.mjs', 'dml-plan.mjs', 'ddl-plan.mjs', 'primary-keys.mjs', 'oracle-temporal.mjs', 'request-timeouts.mjs', 'cell-value.mjs']) {
  await copyFile('src/host/' + file, 'lib/' + file)
}
for (const file of ['types.mjs', 'mysql.mjs', 'oracle.mjs', 'registry.mjs']) {
  await copyFile('src/host/dialects/' + file, 'lib/dialects/' + file)
}
const providerOutput = resolve('lib/data-sources'), libRoot = resolve('lib')
if (!providerOutput.startsWith(libRoot + sep)) throw new Error('Provider output is outside lib')
await rm(providerOutput, { recursive: true, force: true })
await copyTree('src/host/data-sources', 'lib/data-sources')
await copyFile('src/shared/connection-permission.mjs', 'lib/shared/connection-permission.mjs')
await copyFile('src/shared/limits.mjs', 'lib/shared/limits.mjs')
await build({ entryPoints: ['src/client/index.tsx'], bundle: true, platform: 'browser', format: 'cjs', external: ['react', 'react-dom', 'react/jsx-runtime'], outfile: 'lib/client.js', loader: { '.png': 'dataurl' }, define: { __DATABASE_CSS__: JSON.stringify(css) } })
const client = await readFile('lib/client.js', 'utf8')
await writeFile('lib/client.js', `window.__ModuleLoader__.load({id:"dsh-database",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${client}\nreturn module.exports;}});\n`)
await build({ entryPoints: ['preview/index.tsx'], bundle: true, platform: 'browser', format: 'esm', outfile: 'lib/preview/preview.js', loader: { '.png': 'dataurl' } })
await copyFile('preview/index.html', 'lib/preview/index.html')
await copyFile('src/client/style.css', 'lib/preview/preview.css')
// The shipped host/client must not contain preview fixture data.
if ((await readFile('lib/client.js', 'utf8')).includes('ORD-20260912-')) throw new Error('Preview fixture leaked into host client')
console.log('Built host ESM, DSH client factory and isolated preview.')

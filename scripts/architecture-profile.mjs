import { performance } from 'node:perf_hooks'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, relative, sep } from 'node:path'
import { build } from 'esbuild'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { ConversationWorkbenchStore } from '../src/host/conversation-workbench-store.ts'

const root = resolve(import.meta.dirname, '..')
const artifacts = join(root, 'artifacts')
mkdirSync(artifacts, { recursive: true })
const scratch = mkdtempSync(join(artifacts, 'architecture-profile-'))
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return { count: values.length, totalMs: values.reduce((a, b) => a + b, 0), p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.floor(sorted.length * .95)], maxMs: sorted.at(-1) }
}
const measure = (samples, work) => { const start = performance.now(); work(); samples.push(performance.now() - start) }
async function dependencies() {
  const files = []
  const walk = path => { for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (/\.(?:tsx?|mjs|js)$/.test(file)) files.push(file)
  } }
  walk(join(root, 'src'))
  const graph = new Map(files.map(file => [file, []]))
  const { metafile } = await build({entryPoints:Object.fromEntries(files.map(file => [relative(root,file),file])),bundle:false,write:false,metafile:true,outdir:join(artifacts,'architecture-graph'),format:'esm',logLevel:'silent'})
  for (const [input, info] of Object.entries(metafile.inputs)) {
    const file = resolve(root, input)
    for (const dependency of info.imports) {
      const spec = dependency.path
      if (dependency.kind !== 'import-statement' || !spec.startsWith('.')) continue
      const target = resolve(dirname(file), spec)
      const resolved = [target, target+'.ts', target+'.tsx', target+'.mjs', join(target,'index.ts')].find(candidate => graph.has(candidate))
      if (resolved) graph.get(file).push(resolved)
    }
  }
  let index = 0
  const indices = new Map(), lows = new Map(), stack = [], active = new Set(), cycles = []
  const visit = file => {
    indices.set(file, index); lows.set(file, index++); stack.push(file); active.add(file)
    for (const child of graph.get(file)) {
      if (!indices.has(child)) { visit(child); lows.set(file, Math.min(lows.get(file), lows.get(child))) }
      else if (active.has(child)) lows.set(file, Math.min(lows.get(file), indices.get(child)))
    }
    if (indices.get(file) === lows.get(file)) {
      const group = []; let child
      do { child = stack.pop(); active.delete(child); group.push(relative(root, child)) } while (child !== file)
      if (group.length > 1 || graph.get(file).includes(file)) cycles.push(group)
    }
  }
  for (const file of files) if (!indices.has(file)) visit(file)
  return { files: files.length, runtimeImportCycles: cycles }
}
try {
  if (process.argv.includes('--dependencies-only')) {
    const path = join(artifacts,'architecture-profile.json')
    const previous = existsSync(path) ? JSON.parse(readFileSync(path,'utf8')) : {}
    const report = {...previous,graphCheckedAt:new Date().toISOString(),...await dependencies()}
    writeFileSync(path,JSON.stringify(report,null,2)); console.log(JSON.stringify({files:report.files,runtimeImportCycles:report.runtimeImportCycles}))
  } else {
  const executions = new ExecutionStore(scratch, 'async')
  const serialization = []
  // Measure near the global ledger cap, rather than only an almost empty store.
  for (let i = 0; i < 1900; i++) {
    const row = executions.create({ conversationId: 'profile', connectionId: `warm-${i % 20}`, operation: 'query', sql: 'SELECT 1' })
    executions.complete(row.executionId, 'succeeded', 'done')
  }
  for (let i = 0; i < 150; i++) measure(serialization, () => {
    const row = executions.create({ conversationId: 'profile', connectionId: `connection-${i % 3}`, operation: 'query', sql: 'SELECT 1', documentText: 'SELECT 1'.repeat(100) })
    executions.complete(row.executionId, 'succeeded', 'done', { columns: ['id'], rows: [[i]], elapsedMs: 1, truncated: false })
  })
  const flushStart = performance.now(); await executions.dispose()
  const flushMs = performance.now() - flushStart
  const documents = new ConversationWorkbenchStore(scratch), documentWrites = []
  for (let i = 0; i < 50; i++) measure(documentWrites, () => documents.save('profile', {
    lastActiveId: 'c', workbenches: { c: { aiDocument: { sourceId: 'mysql', text: 'SELECT 1;\n'.repeat(1500), context: { schema: 'app' }, revision: i + 1, controller: 'user' } } },
  }, new Set(['c'])))
  const report = { measuredAt: new Date().toISOString(), node: process.version, platform: process.platform,
    scope: 'Controlled local filesystem; execution samples include snapshot serialization and lifecycle bookkeeping. No databases or Desktop.',
    executionLifecycle: stats(serialization), asyncFlushMs: flushMs, documentCommit: stats(documentWrites),
    historyWarmupOperations: 1900, historyEntries: JSON.parse(readFileSync(join(scratch, 'ai-executions.json'), 'utf8')).records.length,
    historyBytes: statSync(join(scratch, 'ai-executions.json')).size, ...await dependencies() }
  writeFileSync(join(artifacts, 'architecture-profile.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  }
} finally {
  const checked = resolve(scratch)
  if (!checked.startsWith(resolve(artifacts) + sep) || !existsSync(checked)) throw new Error('Invalid profiling scratch directory')
  rmSync(checked, { recursive: true, force: true })
}

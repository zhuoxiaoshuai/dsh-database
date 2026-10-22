import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile, lstat, open } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rulesVersion = 2
const digest = value => createHash('sha256').update(value).digest('hex')
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--out') throw new Error('Usage: npm run pack:standalone-runtime -- --out <directory>')
const output = resolve(args[1])
await mkdir(output, { recursive: true })
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const lock = await readFile(join(root, 'package-lock.json'))
// Self-version does not change the dependency archive cache.
const lockData = JSON.parse(lock)
delete lockData.version
if (lockData.packages?.['']) delete lockData.packages[''].version
const fingerprint = digest(JSON.stringify({ lock: lockData, platform: process.platform, arch: process.arch, node: process.versions.node.split('.')[0], rulesVersion }))
const cacheRoot = join(root, 'artifacts', 'standalone-runtime')
await mkdir(cacheRoot, { recursive: true })
const cacheLock=join(cacheRoot,'.running')
for(let attempt=0;attempt<2;attempt++) {
  try { const fd=await open(cacheLock,'wx'); try {await fd.writeFile(String(process.pid))}finally{await fd.close()} break }
  catch(e) {
    if(e.code!=='EEXIST')throw e
    const pid=Number(await readFile(cacheLock,'utf8'))
    if(!Number.isInteger(pid)||pid<=0)throw Error('Invalid standalone cache lock')
    try{process.kill(pid,0)}catch(error){if(error.code==='ESRCH'){await rm(cacheLock);continue}throw error}
    throw Error(`Standalone runtime cache is busy (PID ${pid})`)
  }
}
try {
const stageRecord=join(cacheRoot,'.stage.json')
if(await stat(stageRecord).then(()=>true,()=>false)) {
  try {
    const old=JSON.parse(await readFile(stageRecord,'utf8')), target=resolve(old.stage)
    let running=true
    if(Number.isInteger(old.pid)&&old.pid>0){try{process.kill(old.pid,0)}catch(e){if(e.code==='ESRCH')running=false}}
    if(!running&&dirname(target)===resolve(tmpdir())&&/^dsh-runtime-[a-f0-9-]{36}$/.test(target.slice(target.lastIndexOf(sep)+1))) {
      async function check(dir){if((await lstat(dir)).isSymbolicLink())throw Error('Linked runtime staging path');for(const e of await readdir(dir,{withFileTypes:true})){const file=join(dir,e.name);if((await lstat(file)).isSymbolicLink())throw Error('Linked runtime staging path');if(e.isDirectory())await check(file)}}
      if(await stat(target).then(()=>true,()=>false)){await check(target);await rm(target,{recursive:true,force:true})}
      await rm(stageRecord,{force:true})
    }
  }catch(e){console.warn(`Runtime staging cleanup deferred: ${e.message}`)}
}
const cache = join(cacheRoot, fingerprint)
const archive = join(cache, 'standalone-modules.tgz'), receiptPath = join(cache, 'receipt.json')
const dest = join(output, 'standalone-modules.tgz')
async function validCache() {
  try { const receipt = JSON.parse(await readFile(receiptPath, 'utf8')); return receipt.fingerprint === fingerprint && receipt.sha256 === digest(await readFile(archive)) } catch { return false }
}
if (await validCache()) {
  await copyFile(archive, dest)
  console.log(JSON.stringify({ ...JSON.parse(await readFile(receiptPath, 'utf8')), cached: true, path: dest }))
} else {
  const stage = join(tmpdir(), `dsh-runtime-${randomUUID()}`)
  if (!resolve(stage).startsWith(resolve(tmpdir()) + sep) || resolve(stage).startsWith(root + sep)) throw new Error('Runtime staging must stay in its own temporary directory outside the checkout')
  await mkdir(stage, { recursive: true })
  await writeFile(stageRecord,JSON.stringify({pid:process.pid,stage}))
  const run = (file, argv, cwd = stage) => {
    const result = spawnSync(file, argv, { cwd, stdio: 'inherit', windowsHide: true, env: { ...process.env, NODE_PATH: '' } })
    if (result.error || result.status !== 0) throw new Error(`${file} failed (${result.status}): ${result.error?.message ?? ''}`)
  }
  try {
    await copyFile(join(root, 'package.json'), join(stage, 'package.json'))
    await copyFile(join(root, 'package-lock.json'), join(stage, 'package-lock.json'))
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    // This repository's lock was generated with legacy peer resolution; the
    // standalone archive does not supply the optional DSH Host peer graph.
    run(process.execPath, [npmCli, 'ci', '--omit=dev', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund', process.env.DSH_PACK_OFFLINE === '1' ? '--offline' : '--prefer-offline', '--loglevel=error'])
    let beforeBytes = 0, afterBytes = 0
    const files = []
    async function walk(directory) {
      for (const entry of await readdir(join(stage, directory), { withFileTypes: true })) {
        const relative = `${directory}/${entry.name}`, path = join(stage, relative)
        if (entry.isDirectory()) { await walk(relative); continue }
        if (!entry.isFile()) throw new Error(`Unexpected runtime symlink: ${relative}`)
        const size = (await stat(path)).size
        beforeBytes += size
        if (/\.(?:map|d\.(?:ts|mts|cts))$/i.test(entry.name)) { await rm(path); continue }
        afterBytes += size
        files.push({ path: relative, sha256: digest(await readFile(path)) })
      }
    }
    await walk('node_modules')
    const require = createRequire(join(stage, 'package.json'))
    for (const name of Object.keys(pkg.dependencies)) {
      if (!require.resolve(name).startsWith(join(stage, 'node_modules'))) throw new Error(`Runtime dependency escaped staging directory: ${name}`)
    }
    // Exercise runtime parsers/formatters after pruning, not just package directories.
    const { Parser } = require('node-sql-parser')
    new Parser().astify('SELECT 1')
    const formatter = require('sql-formatter')
    formatter.format('select 1', { language: 'mysql' })
    require('@griffithswaite/ts-plsql-parser')
    // Import the real built standalone entry outside the development tree.
    // Its direct-run guard prevents starting a server during this check.
    await cp(join(root, 'lib'), join(stage, 'lib'), { recursive: true })
    run(process.execPath, ['--input-type=module', '-e', "await import('./lib/serve.js')"])
    const runtime = { schemaVersion: 1, fingerprint, platform: process.platform, arch: process.arch, nodeMajor: Number(process.versions.node.split('.')[0]), dependencies: Object.keys(pkg.dependencies), files }
    await writeFile(join(stage, '.runtime-manifest.json'), JSON.stringify(runtime))
    await writeFile(join(stage, '.runtime-verify.cjs'), `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{createRequire}=require('node:module');\ntry{const root=__dirname,m=JSON.parse(fs.readFileSync(path.join(root,'.runtime-manifest.json')));if(m.schemaVersion!==1||m.platform!==process.platform||m.arch!==process.arch||Number(process.versions.node.split('.')[0])<m.nodeMajor)throw Error('Runtime platform/Node mismatch');for(const f of m.files){if(!f.path.startsWith('node_modules/')||f.path.split('/').includes('..'))throw Error('Invalid runtime path');const hash=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f.path))).digest('hex');if(hash!==f.sha256)throw Error('Runtime file changed: '+f.path)}const req=createRequire(path.join(root,'package.json'));for(const name of m.dependencies)req.resolve(name)}catch(e){console.error(e.message);process.exitCode=1}\n`)
    await mkdir(cache, { recursive: true })
    const pending = join(stage, 'standalone-modules.tgz')
    run('tar', ['-czf', pending, '-C', stage, 'node_modules', '.runtime-manifest.json', '.runtime-verify.cjs'])
    const receipt = { fingerprint, rulesVersion, beforeBytes, afterBytes, compressedBytes: (await stat(pending)).size, sha256: digest(await readFile(pending)) }
    const published = `${archive}.${randomUUID()}.tmp`
    await copyFile(pending, published)
    await rename(published, archive)
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
    await copyFile(archive, dest)
    console.log(JSON.stringify({ ...receipt, cached: false, path: dest }))
  } finally { await rm(stage, { recursive: true, force: true }); await rm(stageRecord,{force:true}) }
}
// Cache retention follows successful use, not task IDs or plugin version bumps.
const receipt=JSON.parse(await readFile(receiptPath,'utf8'))
receipt.lastUsedAt=new Date().toISOString()
await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n')
const valid=[]
for(const entry of await readdir(cacheRoot,{withFileTypes:true})) {
  if(!entry.isDirectory()||!/^[a-f0-9]{64}$/.test(entry.name))continue
  const dir=join(cacheRoot,entry.name)
  if((await lstat(dir)).isSymbolicLink())continue
  try {
    const r=JSON.parse(await readFile(join(dir,'receipt.json'),'utf8'))
    if(r.fingerprint!==entry.name||r.sha256!==digest(await readFile(join(dir,'standalone-modules.tgz'))))continue
    valid.push({dir,date:r.lastUsedAt??(await stat(dir)).mtime.toISOString()})
  }catch{/* Do not delete unclassified cache contents. */}
}
for(const item of valid.sort((a,b)=>b.date.localeCompare(a.date)).slice(2)) {
  async function unlinked(dir) { for(const e of await readdir(dir,{withFileTypes:true})){const f=join(dir,e.name);if((await lstat(f)).isSymbolicLink())throw Error('Linked runtime cache path');if(e.isDirectory())await unlinked(f)} }
  try{await unlinked(item.dir);await rm(item.dir,{recursive:true,force:true})}catch(e){console.warn(`Cache cleanup deferred: ${e.message}`)}
}
} finally { await rm(cacheLock,{force:true}) }

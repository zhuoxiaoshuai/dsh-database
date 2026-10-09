import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ExecutionStore } from '../src/host/execution-store.ts'
const directory = await mkdtemp(join(tmpdir(), 'dsh-storage-fault-'))
const report = { status: 'RUNNING', scope: 'owned child process and temporary storage only', checks: [] }
let child, store
const originalWriteFile = fsPromises.writeFile
try {
  const crashRoot = join(directory, 'crash'); await mkdir(crashRoot)
  child = fork(new URL('./storage-fault-child.mjs', import.meta.url), [crashRoot], { silent: true, windowsHide: true })
  const [ids] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('child exited before durable ready') })])
  const disk = JSON.parse(await readFile(join(crashRoot, 'ai-executions.json'), 'utf8'))
  assert.equal(disk.records.find(row => row.executionId === ids.sent).status, 'running')
  assert.ok(disk.records.find(row => row.executionId === ids.sent).events.some(event => event.kind === 'dispatched'))
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; child = undefined
  store = new ExecutionStore(crashRoot, 'async')
  assert.equal(store.get('fault', ids.sent).status, 'unknown'); assert.equal(store.get('fault', ids.unsent).status, 'cancelled')
  assert.equal(store.list('fault').length, 2); assert.equal((await store.retryPersistence()).saved, true)
  await store.dispose(); store = undefined
  report.checks.push('forced own-process termination after confirmed durable active records; recovery unknown/cancelled without replay')

  const failureRoot = join(directory, 'failure'); await mkdir(failureRoot)
  store = new ExecutionStore(failureRoot, 'async')
  const ledger = join(failureRoot, 'ai-executions.json')
  await mkdir(ledger); await writeFile(join(ledger, 'blocker'), 'owned fixture')
  const times = []
  fsPromises.writeFile = async (...args) => {
    if (String(args[0]).startsWith(failureRoot) && String(args[0]).endsWith('.tmp')) times.push(Date.now())
    return originalWriteFile(...args)
  }
  syncBuiltinESMExports()
  const row = store.create({ conversationId: 'fault', operation: 'sql' })
  const initial = Date.now()
  while (times.length < 4 && Date.now() - initial < 42000) await delay(100)
  assert.equal(times.length, 4, 'initial attempt plus exactly 1/5/30 second bounded retries')
  assert.ok(times[1] - times[0] >= 900); assert.ok(times[2] - times[1] >= 4800); assert.ok(times[3] - times[2] >= 29500)
  assert.equal(store.storageDegraded, true); assert.equal(store.persistenceRetrying, false)
  store.annotate(row.executionId, { title: 'latest snapshot after exhausted retries' })
  const a = store.retryPersistence(), b = store.retryPersistence()
  assert.equal(a, b, 'concurrent manual retry is coalesced')
  assert.equal((await a).saved, false); assert.equal(store.storageDegraded, true)
  store.annotate(row.executionId, { title: 'latest snapshot after manual failure' })
  await rm(ledger, { recursive: true, force: true })
  assert.equal((await store.retryPersistence()).saved, true)
  assert.equal(store.storageDegraded, false)
  const restored = JSON.parse(await readFile(ledger, 'utf8'))
  assert.equal(restored.records[0].title, 'latest snapshot after manual failure')
  assert.equal(store.get('fault', row.executionId).status, 'preparing')
  report.checks.push('persistent real filesystem failure, 1/5/30 retries exhausted, concurrent retry joined, failed retry visible, latest memory snapshot recovered')
  report.status = 'PASS'
} catch (error) { report.status = 'FAIL'; report.error = error.message; process.exitCode = 1 }
finally {
  fsPromises.writeFile = originalWriteFile; syncBuiltinESMExports()
  if (child) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
  await store?.dispose()
  await rm(directory, { recursive: true, force: true })
  console.log(JSON.stringify(report))
  await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/storage-fault-acceptance.json', JSON.stringify(report, null, 2))
}

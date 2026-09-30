import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { canTransition, clipResultPreview } from '../src/shared/execution.ts'

function store(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-exec-'))
  const executions = new ExecutionStore(directory)
  t.after(async () => { await executions.dispose(); rmSync(directory, { recursive: true, force: true }) })
  return { executions, directory }
}

test('execution status machine rejects backward transitions', () => {
  assert.equal(canTransition('preparing', 'checking'), true)
  assert.equal(canTransition('checking', 'running'), true)
  assert.equal(canTransition('succeeded', 'running'), false)
  assert.equal(canTransition('failed', 'preparing'), false)
})

test('result previews clip columns and every row to 64 cells', () => {
  const columns = Array.from({ length: 70 }, (_, index) => `c${index}`)
  const row = Array.from({ length: 70 }, (_, index) => String(index))
  const preview = clipResultPreview({ columns, rows: [row], truncated: false, elapsedMs: 1 })
  assert.equal(preview?.columns.length, 64)
  assert.equal(preview?.rows[0].length, 64)
  assert.equal(preview?.rows[0][63], '63')
  const batched = clipResultPreview({
    columns: ['b'], rows: [['2']], truncated: false, elapsedMs: 2,
    batch: [
      { columns: ['a'], rows: [['1']], truncated: false, elapsedMs: 1, sql: 'SELECT 1' },
      { columns: ['b'], rows: [['2']], truncated: false, elapsedMs: 1, sql: 'SELECT 2' },
    ],
  })
  assert.equal(batched?.batch?.length, 2)
  assert.equal(batched?.batch?.[0].sql, 'SELECT 1')
})

test('execution store isolates conversations, keeps call ids, and persists a clipped preview', async t => {
  const { executions, directory } = store(t)
  const a = executions.create({ conversationId: 'c1', callId: 'call-a', rootCallId: 'root-a', operation: 'database_query_readonly', sql: 'SELECT 1', params: ['secret'], initiator: 'ai' })
  executions.create({ conversationId: 'c2', callId: 'call-b', operation: 'database_list_schemas', initiator: 'user' })
  assert.equal(executions.list('c1').length, 1)
  assert.equal(executions.list('c1')[0].callId, 'call-a')
  assert.equal(executions.list('c1')[0].initiator, 'ai')
  assert.equal(Object.hasOwn(executions.list('c1')[0], 'resultPreview'), false)
  assert.equal(executions.get('c2', a.executionId), undefined)
  executions.complete(a.executionId, 'succeeded', 'ok', { columns: ['note'], rows: [['secret-value']], truncated: false, elapsedMs: 3 })
  const disk = readFileSync(join(directory, 'ai-executions.json'), 'utf8')
  assert.equal(disk.includes('secret-value'), true)
  assert.equal(disk.includes('password'), false)
  assert.equal(disk.includes('protectedPassword'), false)
  const persisted = JSON.parse(disk).records.find(row => row.callId === 'call-a')
  assert.equal(persisted.paramSummary[0].type, 'string')
  assert.equal(persisted.initiator, 'ai')
  const listed = executions.list('c1')[0]
  assert.equal(listed.result, undefined)
  const live = executions.get('c1', a.executionId, true)
  assert.deepEqual(live?.result?.rows[0], ['secret-value'])
  const reloaded = new ExecutionStore(directory)
  t.after(() => reloaded.dispose())
  const restored = reloaded.get('c1', a.executionId, true)
  assert.equal(restored?.resultMeta?.rowCount, 1)
  assert.deepEqual(restored?.result?.rows[0], ['secret-value'])
  assert.equal(restored?.resultMissing, undefined)
})

test('execution store keeps query draft sql across reload', async t => {
  const { executions, directory } = store(t)
  const record = executions.create({ conversationId: 'c1', operation: 'database_search_tables', sql: 'SELECT TABLE_NAME FROM information_schema.TABLES' })
  executions.annotate(record.executionId, { draft: { kind: 'query', sql: 'SELECT * FROM `demo`.`users` LIMIT 100' } })
  const reloaded = new ExecutionStore(directory)
  t.after(() => reloaded.dispose())
  const restored = reloaded.get('c1', record.executionId)
  assert.equal(restored?.sql, 'SELECT TABLE_NAME FROM information_schema.TABLES')
  assert.equal(restored?.draft?.kind, 'query')
  assert.match(String(restored?.draft?.sql || ''), /SELECT \*/)
})

test('generation invalidation does not apply late results to a new generation', async t => {
  const { executions } = store(t)
  const record = executions.create({ conversationId: 'c1', connectionId: 'db1', generation: 'g1', operation: 'database_query_readonly' })
  executions.transition(record.executionId, 'checking')
  executions.transition(record.executionId, 'running')
  executions.event(record.executionId, 'dispatched')
  executions.invalidateGeneration('db1', 'g1', 'reconnect')
  assert.equal(executions.get('c1', record.executionId)?.status, 'unknown')
  executions.complete(record.executionId, 'succeeded', 'late', { columns: ['id'], rows: [['1']], truncated: false, elapsedMs: 1 })
  assert.equal(executions.get('c1', record.executionId)?.status, 'unknown')
  assert.ok(executions.get('c1', record.executionId)?.events.some(event => event.kind === 'late-result'))
})

test('store caps conversations and cancel before dispatch is cancelled', async t => {
  const { executions } = store(t)
  for (let i = 0; i < 102; i++) executions.create({ conversationId: 'c1', operation: 'n' + i })
  assert.equal(executions.list('c1').length, 100)
  const record = executions.create({ conversationId: 'c1', operation: 'active' })
  executions.cancel('c1', record.executionId, false)
  assert.equal(executions.get('c1', record.executionId)?.status, 'cancelled')
})

test('store caps each conversation connection bucket independently', async t => {
  const { executions } = store(t)
  for (let i = 0; i < 102; i++) {
    executions.create({ conversationId: 'c1', connectionId: 'db1', operation: 'db1-' + i })
  }
  for (let i = 0; i < 50; i++) {
    executions.create({ conversationId: 'c1', connectionId: 'db2', operation: 'db2-' + i })
  }
  const listed = executions.list('c1')
  assert.equal(listed.filter(row => row.connectionId === 'db1').length, 100)
  assert.equal(listed.filter(row => row.connectionId === 'db2').length, 50)
  assert.equal(listed.length, 150)
})

test('store keeps in-flight records when trimming a connection bucket', async t => {
  const { executions } = store(t)
  for (let i = 0; i < 100; i++) {
    const row = executions.create({ conversationId: 'c1', connectionId: 'db1', operation: 'done-' + i })
    executions.complete(row.executionId, 'succeeded', 'ok')
  }
  const active = executions.create({ conversationId: 'c1', connectionId: 'db1', operation: 'still-running' })
  executions.transition(active.executionId, 'running')
  for (let i = 0; i < 5; i++) {
    const row = executions.create({ conversationId: 'c1', connectionId: 'db1', operation: 'new-done-' + i })
    executions.complete(row.executionId, 'succeeded', 'ok')
  }
  assert.ok(executions.get('c1', active.executionId))
  assert.equal(executions.list('c1').filter(row => row.connectionId === 'db1').length, 100)
})

test('execution store clips preview to 100 rows and drops oldest previews to keep the file budget', async t => {
  const { executions, directory } = store(t)
  const fat = executions.create({ conversationId: 'c1', operation: 'fat', initiator: 'user' })
  executions.complete(fat.executionId, 'succeeded', 'ok', {
    columns: ['note'],
    rows: Array.from({ length: 250 }, (_, i) => [`row-${i}-${'x'.repeat(80)}`]),
    truncated: false,
    elapsedMs: 1,
  })
  const preview = executions.get('c1', fat.executionId, true)?.result
  assert.ok((preview?.rows.length || 0) <= 100)
  for (let i = 0; i < 40; i++) {
    const rec = executions.create({ conversationId: 'c1', operation: 'bulk-' + i, initiator: 'ai' })
    executions.complete(rec.executionId, 'succeeded', 'ok', {
      columns: ['blob'],
      rows: Array.from({ length: 100 }, () => ['y'.repeat(400)]),
      truncated: false,
      elapsedMs: 1,
    })
  }
  const disk = readFileSync(join(directory, 'ai-executions.json'), 'utf8')
  assert.ok(Buffer.byteLength(disk) <= 2 * 1024 * 1024)
  assert.equal(disk.includes('password'), false)
})

test('execution store persists title reason conclusion and failed conclusions', async t => {
  const { executions, directory } = store(t)
  const ok = executions.create({
    conversationId: 'c1', operation: 'database_search_tables', title: '查找 app 中的表', reason: '为定位匹配的业务表。', initiator: 'ai',
  })
  executions.complete(ok.executionId, 'succeeded', undefined, undefined, '找到 12 个表。')
  const fail = executions.create({ conversationId: 'c1', operation: 'database_query_readonly', title: '执行只读查询' })
  executions.complete(fail.executionId, 'failed', '语法错误')
  const disk = JSON.parse(readFileSync(join(directory, 'ai-executions.json'), 'utf8'))
  const savedOk = disk.records.find(row => row.executionId === ok.executionId)
  assert.equal(savedOk.title, '查找 app 中的表')
  assert.equal(savedOk.reason, '为定位匹配的业务表。')
  assert.equal(savedOk.conclusion, '找到 12 个表。')
  const reloaded = new ExecutionStore(directory)
  t.after(() => reloaded.dispose())
  assert.equal(reloaded.get('c1', ok.executionId)?.conclusion, '找到 12 个表。')
  assert.equal(reloaded.get('c1', fail.executionId)?.conclusion, '语法错误')
})

test('async persist defers disk writes and converges on dispose', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-exec-async-'))
  const executions = new ExecutionStore(directory, 'async')
  t.after(async () => { await executions.dispose(); rmSync(directory, { recursive: true, force: true }) })
  const record = executions.create({ conversationId: 'c1', operation: 'async-test', initiator: 'ai' })
  executions.complete(record.executionId, 'succeeded', 'ok', { columns: ['a'], rows: [['1']], truncated: false, elapsedMs: 1 })
  // 异步模式：内存立即可见
  assert.equal(executions.get('c1', record.executionId)?.status, 'succeeded')
  const file = join(directory, 'ai-executions.json')
  // dispose 后写链收敛：磁盘即最新（无论写盘发生在 create 后还是 complete 后，最终都是 complete 态）
  await executions.dispose()
  const disk = JSON.parse(readFileSync(file, 'utf8'))
  const saved = disk.records.find(row => row.executionId === record.executionId)
  assert.ok(saved)
  assert.equal(saved.status, 'succeeded')
  assert.equal(saved.conclusion, '返回 1 行')
  // 高频写合并：同刻多次修改只落盘最终状态（这里复用已收敛的文件再验证一次内容正确性）
  const reloaded = new ExecutionStore(directory, 'async')
  t.after(() => reloaded.dispose())
  assert.deepEqual(reloaded.get('c1', record.executionId, true)?.result?.rows[0], ['1'])
})

test('wait reports a gap after workbench events fall out of the log window', async t => {
  const { executions } = store(t)
  executions.emitWorkbench('c1', { type: 'QUERY_CHANGED', connectionId: 'a', sql: 'SELECT 1', queryRevision: 1 })
  const first = await executions.wait('c1', 0, 1)
  assert.equal(first.gap, false)
  const seen = first.revision
  for (let i = 0; i < 90; i++) executions.emitWorkbench('c1', { type: 'EXECUTION_FINISHED', connectionId: 'x', executionId: `e${i}` })
  const page = await executions.wait('c1', seen, 1)
  assert.equal(page.gap, true)
})

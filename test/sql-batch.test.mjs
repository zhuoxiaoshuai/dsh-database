import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyManualSql, createSqlBatch, formatSqlBatchStatus, resolveRunStatements, resultTabLabel, runSqlBatch, summarizeSqlBatch } from '../src/shared/sql-batch.ts'
test('result tabs are numbered in execution order', () => {
  assert.equal(resultTabLabel(0, 1), '结果')
  assert.equal(resultTabLabel(0, 2), '结果1')
  assert.equal(resultTabLabel(1, 2), '结果2')
})

test('runSqlBatch expands a multi-result payload into sequential steps', async () => {
  const steps = createSqlBatch(['SELECT 1; SELECT 2'])
  const result = await runSqlBatch({
    steps,
    signal: new AbortController().signal,
    execute: async () => ({
      columns: ['n'],
      rows: [['2']],
      truncated: false,
      elapsedMs: 3,
      batch: [
        { columns: ['n'], rows: [['1']], truncated: false, elapsedMs: 1, sql: 'SELECT 1' },
        { columns: ['n'], rows: [['2']], truncated: false, elapsedMs: 2, sql: 'SELECT 2' },
      ],
    }),
  })
  assert.equal(result.length, 2)
  assert.equal(result[0].sql, 'SELECT 1')
  assert.deepEqual(result[0].result?.rows, [['1']])
  assert.equal(result[1].sql, 'SELECT 2')
  assert.deepEqual(result[1].result?.rows, [['2']])
})

test('resolveRunStatements uses selection, current statement, or all statements', () => {
  const sql = 'SELECT 1;\nUPDATE t SET x = 1;\nDELETE FROM t WHERE x = 1'
  const all = resolveRunStatements({ sql, dialect: 'mysql', cursor: 0, mode: 'all' })
  assert.equal(all.length, 3)
  const current = resolveRunStatements({ sql, dialect: 'mysql', cursor: sql.indexOf('UPDATE'), mode: 'selection-or-current' })
  assert.equal(current.length, 1)
  assert.match(current[0].sql, /UPDATE t/)
  const selected = resolveRunStatements({ sql, dialect: 'mysql', selection: 'SELECT 1; UPDATE t SET x = 1', mode: 'selection-or-current' })
  assert.equal(selected.length, 2)
})

test('classifyManualSql covers CRUD and rejects DDL', () => {
  assert.equal(classifyManualSql('-- note\nDELETE FROM t'), 'delete')
  assert.equal(classifyManualSql('INSERT INTO t (id) VALUES (1)'), 'insert')
  assert.equal(classifyManualSql('DROP TABLE t'), 'other')
})

test('runSqlBatch commits each statement then stops, keeping earlier successes', async () => {
  const calls = []
  const steps = createSqlBatch(['SELECT 1', 'UPDATE t SET x = 1', 'SELECT 2'])
  const result = await runSqlBatch({
    steps,
    signal: new AbortController().signal,
    execute: async sql => {
      calls.push(sql.trim())
      if (sql.includes('UPDATE')) throw new Error('boom')
      return { columns: ['n'], rows: [['1']], truncated: false, elapsedMs: 4, affectedRows: sql.includes('UPDATE') ? 1 : 0 }
    },
  })
  assert.deepEqual(calls, ['SELECT 1', 'UPDATE t SET x = 1'])
  assert.equal(result[0].status, 'ok')
  assert.equal(result[1].status, 'failed')
  assert.equal(result[2].status, 'skipped')
  const summary = summarizeSqlBatch(result)
  assert.equal(summary.ok, 1)
  assert.equal(summary.failed, 1)
  assert.match(formatSqlBatchStatus(result), /1\/3 成功/)
})

test('runSqlBatch abort after send is unknown; statements not yet sent stay cancelled', async () => {
  const controller = new AbortController()
  const steps = createSqlBatch(['SELECT 1', 'SELECT 2'])
  const result = await runSqlBatch({
    steps,
    signal: controller.signal,
    execute: async () => {
      controller.abort()
      throw Object.assign(new Error('已取消'), { cancelled: true })
    },
  })
  assert.equal(result[0].status, 'unknown')
  assert.equal(result[0].error, '结果未知。')
  assert.equal(result[1].status, 'cancelled')
})

test('runSqlBatch keeps a query timeout as failure, not cancel', async () => {
  const steps = createSqlBatch(['SELECT 1'])
  const result = await runSqlBatch({
    steps,
    signal: new AbortController().signal,
    execute: async () => { throw new Error('查询超过 32 秒，已超时；共享连接仍可用。') },
  })
  assert.equal(result[0].status, 'failed')
  assert.match(result[0].error || '', /已超时/)
  assert.equal(/已取消/.test(result[0].error || ''), false)
})

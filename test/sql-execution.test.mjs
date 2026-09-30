import test from 'node:test'
import assert from 'node:assert/strict'
import { executeDml } from '../src/host/query.mjs'

test('should refuse non-manual sql-page writes when the connection is read-only uat or pvt', async () => {
  for (const env of ['uat', 'pvt']) {
    await assert.rejects(
      executeDml({ sql: 'UPDATE t SET x = 1', schema: 'biz' }, { dialect: 'mysql', environment: env, identity: 'x' }, undefined),
      /只读/,
    )
  }
})

test('manual sql-page writes are allowed in sit/uat/pvt and fail fast without a real database', async () => {
  for (const env of ['sit', 'uat', 'pvt']) {
    await assert.rejects(
      executeDml({ sql: 'DELETE FROM t WHERE x = 1', schema: 'biz', lane: 'manual' }, { dialect: 'mysql', environment: env, host: '127.0.0.1', port: 1, username: 'u', password: 'p', identity: 'x' }, undefined),
    )
  }
})

test('should refuse sql-page writes when dialect is unknown', async () => {
  await assert.rejects(
    executeDml({ sql: 'UPDATE t SET x = 1', schema: 'biz' }, { dialect: 'mssql', environment: 'sit', identity: 'x' }, undefined),
    /方言/,
  )
})

test('should attempt connection for sit environment write and fail fast without a real database', async () => {
  await assert.rejects(
    executeDml({ sql: 'UPDATE t SET x = 1', schema: 'biz' }, { dialect: 'mysql', environment: 'sit', host: '127.0.0.1', port: 1, username: 'u', password: 'p', identity: 'x' }, undefined),
  )
})

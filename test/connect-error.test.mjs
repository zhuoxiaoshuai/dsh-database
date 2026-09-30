import test from 'node:test'
import assert from 'node:assert/strict'
import { databaseErrorDetail, rejectDatabaseError, safeConnectError, sanitizeConnectDetail } from '../src/host/connect-error.mjs'

test('access denied keeps the driver message instead of only a generic hint', () => {
  const text = safeConnectError({
    code: 'ER_ACCESS_DENIED_ERROR',
    message: "Access denied for user 'reader'@'10.0.0.8' (using password: YES)",
  })
  assert.match(text, /认证失败/)
  assert.match(text, /Access denied for user 'reader'@'10\.0\.0\.8'/)
})

test('unknown handshake errors surface the sanitized driver text', () => {
  const text = safeConnectError({ code: 'ER_UNKNOWN', message: 'Unknown system variable \'server_uuid\' password=hunter2' })
  assert.match(text, /连接失败：/)
  assert.match(text, /Unknown system variable/)
  assert.equal(text.includes('hunter2'), false)
  assert.match(text, /password=\*\*\*/)
})

test('sanitizeConnectDetail strips credential assignments', () => {
  assert.equal(sanitizeConnectDetail({ message: 'failed password=secret' }), 'failed password=***')
})

test('database errors keep driver codes instead of collapsing to a generic parse message', () => {
  const oracle = rejectDatabaseError({
    message: 'ORA-00923: FROM keyword not found where expected',
    errorNum: 923,
    offset: 10,
  })
  assert.equal(/数据库拒绝查询/.test(oracle), false)
  assert.match(oracle, /ORA-00923/)
  assert.match(oracle, /位置 10/)
  const mysql = rejectDatabaseError({
    code: 'ER_PARSE_ERROR',
    errno: 1064,
    sqlState: '42000',
    sqlMessage: "You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'FORM records' at line 1",
    message: 'ER_PARSE_ERROR: You have an error in your SQL syntax',
  })
  assert.match(mysql, /ER_PARSE_ERROR/)
  assert.match(mysql, /FORM records/)
  assert.match(mysql, /errno 1064/)
  assert.equal(rejectDatabaseError({ message: '数据库拒绝查询：already wrapped' }), 'already wrapped')
  assert.equal(rejectDatabaseError({ message: '' }), '数据库没有返回错误说明。')
  assert.match(databaseErrorDetail({ code: 'NJS-500', message: '' }), /NJS-500/)
})

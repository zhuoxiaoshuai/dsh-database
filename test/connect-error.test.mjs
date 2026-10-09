import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeErrorText } from '../src/host/connect-error.mjs'

test('access denied returns the driver message exactly', () => {
  const message = "Access denied for user 'reader'@'10.0.0.8' (using password: YES)"
  const text = nativeErrorText({ code: 'ER_ACCESS_DENIED_ERROR', message })
  assert.equal(text, message)
})

test('handshake text keeps passwords and connection details', () => {
  const message = "Unknown system variable 'server_uuid' password=hunter2"
  assert.equal(nativeErrorText({ code: 'ER_UNKNOWN', message }), message)
  assert.equal(nativeErrorText({ message: 'failed password=secret' }), 'failed password=secret')
  assert.equal(nativeErrorText({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:3306' }), 'connect ECONNREFUSED 127.0.0.1:3306')
  assert.equal(nativeErrorText({ code: 'EACCES', message: 'connect EACCES' }), 'connect EACCES')
  assert.equal(nativeErrorText({ code: 'NJS-500', message: 'ORA-12541: TNS:no listener' }), 'ORA-12541: TNS:no listener')
  assert.equal(nativeErrorText({}), '')
})

test('database errors return one native field and do not invent ORA codes', () => {
  const oracle = 'ORA-00923: FROM keyword not found where expected'
  assert.equal(nativeErrorText({ message: oracle, errorNum: 923, offset: 10 }), oracle)
  assert.equal(nativeErrorText({ message: '', errorNum: 923, offset: 10 }), '')
  assert.equal(/ORA-/.test(nativeErrorText({ message: '', errorNum: 923 })), false)

  const mysqlMessage = 'ER_PARSE_ERROR: You have an error in your SQL syntax'
  const mysql = nativeErrorText({
    code: 'ER_PARSE_ERROR',
    errno: 1064,
    sqlState: '42000',
    sqlMessage: "You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'FORM records' at line 1",
    message: mysqlMessage,
  })
  assert.equal(mysql, mysqlMessage)

  const sqlMessage = "You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'FORM records' at line 1"
  assert.equal(nativeErrorText({
    code: 'ER_PARSE_ERROR',
    errno: 1064,
    sqlState: '42000',
    sqlMessage,
    message: '',
  }), sqlMessage)
  assert.equal(nativeErrorText({ message: '数据库拒绝查询：already wrapped' }), '数据库拒绝查询：already wrapped')
  assert.equal(nativeErrorText({ code: 'NJS-500', message: '' }), 'NJS-500')
})

test('description strings and internal whitespace stay unchanged', () => {
  const description = 'connectString=(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ORCL)))'
  assert.equal(nativeErrorText(description), description)
  const spaced = 'keep   double space\nand the newline'
  assert.equal(nativeErrorText(spaced), spaced)
  assert.equal(nativeErrorText({ message: spaced }), spaced)
  assert.equal(nativeErrorText({ message: '', sqlMessage: '', code: '', cause: { message: 'from cause' } }), 'from cause')
})

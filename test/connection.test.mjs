import test from 'node:test'
import assert from 'node:assert/strict'
import { validateConnection, connectionFingerprint, ConnectionService } from '../src/connection-service.ts'
const input = { name: '', dialect: 'mysql', host: 'localhost', port: 3306, database: '', oracleMode: 'service', username: 'dev', password: ' p@ss ', environment: 'dev' }
test('MySQL database/name optional, password whitespace preserved, Oracle target required and descriptors rejected', () => {
  assert.equal(validateConnection(input).name, 'MySQL · localhost:3306')
  assert.equal(validateConnection(input).environment, 'sit')
  assert.equal(validateConnection(input).password, ' p@ss ')
  assert.equal(validateConnection({ ...input, host: '[::1]' }).host, '[::1]')
  for (const patch of [{ port: 0 }, { port: 1.5 }, { host: 'db)(INJECT=x)' }, { host: '[::1](INJECT)' }, { host: '[localhost]' }, { username: '' }, { dialect: 'oracle' }, { dialect: 'oracle', database: 'x)(SID=y)' }, { password: 'x'.repeat(4097) }]) assert.throws(() => validateConnection({ ...input, ...patch }))
  assert.equal(validateConnection({ ...input, dialect: 'oracle', database: 'ORCL', oracleMode: 'sid' }).oracleMode, 'sid')
})
test('passwordOptional allows empty password; live validate still requires one', () => {
  const draft = validateConnection({ ...input, password: '' }, { passwordOptional: true })
  assert.equal(draft.password, '')
  assert.throws(() => validateConnection({ ...input, password: '' }), /请输入密码/)
})
test('connectionFingerprint ignores empty mysql database and lowercases host', () => {
  const base = { dialect: 'mysql', host: 'DB.test', port: 3306, database: '', username: 'reader' }
  assert.equal(connectionFingerprint(base), connectionFingerprint({ ...base, host: 'db.test' }))
  assert.notEqual(connectionFingerprint(base), connectionFingerprint({ ...base, database: 'app' }))
  assert.equal(
    connectionFingerprint({ dialect: 'oracle', host: 'db.test', port: 1521, database: 'ORCL', username: 'scott', oracleMode: 'service' }),
    connectionFingerprint({ dialect: 'oracle', host: 'db.test', port: 1521, database: 'ORCL', username: 'scott', oracleMode: 'service' }),
  )
  assert.notEqual(
    connectionFingerprint({ dialect: 'oracle', host: 'db.test', port: 1521, database: 'ORCL', username: 'scott', oracleMode: 'service' }),
    connectionFingerprint({ dialect: 'oracle', host: 'db.test', port: 1521, database: 'ORCL', username: 'scott', oracleMode: 'sid' }),
  )
})
test('missing/deleted owners and disposed services cannot start connections', async () => {
  const service = new ConnectionService(owner => owner === 'a')
  try { await assert.rejects(service.open('b', input, false)); assert.throws(() => service.list('b')); await service.dispose(); await assert.rejects(service.open('a', input, false)) }
  finally { await service.dispose() }
})

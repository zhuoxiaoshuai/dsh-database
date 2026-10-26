import test from 'node:test'
import assert from 'node:assert/strict'
import { enumerateStatements, splitStatements } from '../src/shared/sql-lex.ts'
import { splitStatements as hostSplitStatements } from '../src/host/data-sources/sql-policy-common.mjs'

const segmentsOf = (sql, dialect) => enumerateStatements(sql, dialect).map(range => range.sql.trim().replace(/;\s*$/, ''))

test('Host policy statement splitting is the shared implementation', () => {
  assert.equal(hostSplitStatements, splitStatements)
})

test('shared splitStatements keeps Host policy statement boundaries', () => {
  assert.deepEqual(splitStatements(''), [])
  assert.deepEqual(splitStatements('   \n\t '), [])
  assert.deepEqual(splitStatements(' ; ; '), [])
  assert.deepEqual(splitStatements('SELECT 1; SELECT 2;'), ['SELECT 1', 'SELECT 2'])
  assert.deepEqual(splitStatements("SELECT ';' FROM t"), ["SELECT ';' FROM t"])
  assert.deepEqual(splitStatements('SELECT `a;b` FROM t'), ['SELECT `a;b` FROM t'])
  assert.deepEqual(splitStatements('SELECT "a;b" FROM t; SELECT 2'), ['SELECT "a;b" FROM t', 'SELECT 2'])
  assert.deepEqual(splitStatements("SELECT 'a\\';b' FROM t"), ["SELECT 'a\\';b' FROM t"])
  assert.deepEqual(splitStatements('-- only a comment'), [])
  assert.deepEqual(splitStatements('# only a comment'), [])
  assert.deepEqual(splitStatements('/* only */'), [])
  assert.deepEqual(splitStatements('SELECT 1; /* trailing */'), ['SELECT 1'])
  assert.deepEqual(splitStatements('-- note\nSELECT 1'), ['-- note\nSELECT 1'])
  assert.deepEqual(splitStatements("SELECT q'[a;b]' FROM dual"), ["SELECT q'[a;b]' FROM dual"])
})

test('policy splitting matches dialect-aware enumeration per dialect', () => {
  // 有意的行为变化：授权切分已改为方言感知，以下三处原 Host 旧行为的差异随之改变。
  // MySQL 下 "--" 后无空格不是注释：原 1 段，现 2 段。
  const dash = 'SELECT 1--x;SELECT 2'
  assert.deepEqual(splitStatements(dash, 'mysql'), ['SELECT 1--x', 'SELECT 2'], 'MySQL 下 "--x" 不是注释，分号应当切分（有意的行为变化）')
  assert.deepEqual(splitStatements(dash, 'mysql'), segmentsOf(dash, 'mysql'), 'MySQL 下 policy 切分与 enumerateStatements 一致')

  // 双引号里的反斜杠会转义：原 2 段，现 1 段。
  const escaped = 'SELECT "a\\";b" FROM t'
  assert.deepEqual(splitStatements(escaped, 'mysql'), [escaped], '双引号内反斜杠转义，分号不再切分（有意的行为变化）')
  assert.deepEqual(splitStatements(escaped, 'mysql'), segmentsOf(escaped, 'mysql'), 'MySQL 下 policy 切分与 enumerateStatements 一致')

  // Oracle 不支持 "#" 注释：原 1 段，现 2 段。
  const hash = 'SELECT 1 # c;SELECT 2'
  assert.deepEqual(splitStatements(hash, 'oracle'), ['SELECT 1 # c', 'SELECT 2'], 'Oracle 下 "#" 不是注释，分号应当切分（有意的行为变化）')
  assert.deepEqual(splitStatements(hash, 'oracle'), segmentsOf(hash, 'oracle'), 'Oracle 下 policy 切分与 enumerateStatements 一致')

  // MySQL 的 "#" 注释仍然生效，不随方言化改变。
  assert.deepEqual(splitStatements(hash, 'mysql'), ['SELECT 1 # c;SELECT 2'], 'MySQL 下 "#" 仍是注释，分号被吞进注释段')
  assert.deepEqual(splitStatements(hash, 'mysql'), segmentsOf(hash, 'mysql'), 'MySQL 下 policy 切分与 enumerateStatements 一致')
})

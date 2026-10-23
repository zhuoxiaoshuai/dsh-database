import test from 'node:test'
import assert from 'node:assert/strict'
import { enumerateStatements, splitStatements } from '../src/shared/sql-lex.ts'
import { splitStatements as hostSplitStatements } from '../src/host/data-sources/sql-policy-common.mjs'

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

test('policy splitting intentionally differs from dialect-aware enumeration', () => {
  // Host policy treats "--x" as a comment even without a space, so the semicolon never splits.
  const dash = 'SELECT 1--x;SELECT 2'
  assert.equal(splitStatements(dash).length, 1)
  assert.equal(enumerateStatements(dash, 'mysql').length, 2)

  // Host policy only escapes single quotes, so the semicolon still splits here.
  const escaped = 'SELECT "a\\";b" FROM t'
  assert.equal(splitStatements(escaped).length, 2)
  assert.equal(enumerateStatements(escaped, 'mysql').length, 1)

  // Host policy treats "#" as a comment even without hash-comment support.
  const hash = 'SELECT 1 # c;SELECT 2'
  assert.equal(splitStatements(hash).length, 1)
  assert.equal(enumerateStatements(hash, 'oracle').length, 2)
})

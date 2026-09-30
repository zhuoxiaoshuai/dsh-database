import test from 'node:test'
import assert from 'node:assert/strict'
import { isExplainSql, unwrapExplainSql, wrapExplainSql } from '../src/shared/sql-text.ts'

test('wrapExplainSql adds dialect prefix and skips duplicate explain', () => {
  assert.equal(wrapExplainSql('mysql', 'SELECT 1'), 'EXPLAIN SELECT 1')
  assert.equal(wrapExplainSql('mysql', 'EXPLAIN SELECT 1'), 'EXPLAIN SELECT 1')
  assert.equal(wrapExplainSql('oracle', 'SELECT 1 FROM dual'), 'EXPLAIN PLAN FOR SELECT 1 FROM dual')
  assert.equal(wrapExplainSql('oracle', 'EXPLAIN PLAN FOR SELECT 1 FROM dual'), 'EXPLAIN PLAN FOR SELECT 1 FROM dual')
})

test('unwrapExplainSql strips outer explain for select checks', () => {
  assert.equal(unwrapExplainSql('EXPLAIN SELECT id FROM t'), 'SELECT id FROM t')
  assert.equal(unwrapExplainSql('EXPLAIN PLAN FOR SELECT id FROM t'), 'SELECT id FROM t')
  assert.equal(isExplainSql('  -- c\nEXPLAIN SELECT 1'), true)
})

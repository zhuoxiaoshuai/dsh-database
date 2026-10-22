import test from 'node:test'
import assert from 'node:assert/strict'
import { sameSqlExperience } from '../src/shared/sql-experience.ts'

const sql = 'SELECT id FROM orders WHERE id = 1'

test('comments, case and formatting stay the same SQL experience', () => {
  assert.equal(sameSqlExperience(sql, `-- 按主键\n${sql}`, 'mysql'), true)
  assert.equal(sameSqlExperience(sql, 'select  id  from  orders  where  id = 1', 'mysql'), true)
  assert.equal(sameSqlExperience(`select id\nfrom orders\nwhere id = 1`, sql, 'mysql'), true)
})

test('a changed condition is a different SQL experience', () => {
  assert.equal(sameSqlExperience(sql, 'SELECT id FROM orders WHERE id = 2', 'mysql'), false)
  assert.equal(sameSqlExperience(sql, 'SELECT id FROM customers WHERE id = 1', 'mysql'), false)
  assert.equal(sameSqlExperience(sql, "SELECT id FROM orders WHERE id = '1'", 'mysql'), false)
})

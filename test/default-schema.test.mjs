import test from 'node:test'
import assert from 'node:assert/strict'
import { connectionOwnsSchema, pickDefaultSchema, takePendingSchema } from '../src/shared/workbench.ts'

test('saved workbench schema wins when still listed', () => {
  assert.equal(pickDefaultSchema({
    dialect: 'oracle',
    schemas: ['SYS', 'HR', 'APP'],
    savedSchema: 'APP',
    username: 'hr',
  }), 'APP')
})

test('Oracle matches login username without depending on catalog order', () => {
  assert.equal(pickDefaultSchema({
    dialect: 'oracle',
    schemas: ['SYS', 'SYSTEM', 'HR', 'XDB'],
    username: 'hr',
  }), 'HR')
})

test('Oracle falls back to the first non-system schema', () => {
  assert.equal(pickDefaultSchema({
    dialect: 'oracle',
    schemas: ['SYS', 'SYSTEM', 'XDB', 'SALES'],
    username: 'nobody',
  }), 'SALES')
})

test('MySQL keeps the current database when it is listed', () => {
  assert.equal(pickDefaultSchema({
    dialect: 'mysql',
    schemas: ['information_schema', 'mysql', 'biz', 'app'],
    database: 'biz',
    username: 'root',
  }), 'biz')
})

test('MySQL ignores a saved schema that belongs to another connection', () => {
  assert.equal(pickDefaultSchema({
    dialect: 'mysql',
    schemas: ['information_schema', 'nl_cl_dev', 'nl_om_dev'],
    savedSchema: 'nl_risk',
    database: 'nl_cl_dev',
    username: 'npl_dev',
  }), 'nl_cl_dev')
})

test('Oracle ignores a saved schema that is not in the catalog list', () => {
  assert.equal(pickDefaultSchema({
    dialect: 'oracle',
    schemas: ['SYS', 'HR'],
    savedSchema: 'OTHER',
    username: 'hr',
  }), 'HR')
})

test('pending schema applies only to the connection it was picked on', () => {
  const pending = { connectionId: 'risk', schema: 'nl_risk' }
  assert.deepEqual(takePendingSchema(pending, 'deb'), { schema: '', rest: pending })
  assert.deepEqual(takePendingSchema(pending, 'risk'), { schema: 'nl_risk' })
  assert.deepEqual(takePendingSchema(undefined, 'deb'), { schema: '' })
})

test('connectionOwnsSchema rejects another connection database even when SHOW DATABASES listed it', () => {
  const deb = { dialect: 'mysql', database: 'nl_cl_dev', databases: ['information_schema', 'nl_cl_dev', 'nl_om_dev'], settings: { username: 'npl_dev' } }
  assert.equal(connectionOwnsSchema(deb, 'nl_cl_dev'), true)
  assert.equal(connectionOwnsSchema(deb, 'information_schema'), true)
  assert.equal(connectionOwnsSchema(deb, 'nl_risk'), false)
})

test('connectionOwnsSchema with empty databases only allows login identity', () => {
  assert.equal(connectionOwnsSchema({ dialect: 'mysql', database: 'app', databases: [] }, 'nl_risk'), false)
  assert.equal(connectionOwnsSchema({ dialect: 'mysql', database: 'app', databases: [] }, 'app'), true)
  assert.equal(connectionOwnsSchema({ dialect: 'oracle', database: 'ORCL', databases: [], settings: { username: 'HR' } }, 'hr'), true)
  assert.equal(connectionOwnsSchema({ dialect: 'oracle', database: 'ORCL', databases: [], settings: { username: 'HR' } }, 'OTHER'), false)
})

test('connectionOwnsSchema always allows the login database even if SHOW DATABASES omitted it', () => {
  assert.equal(connectionOwnsSchema({
    dialect: 'mysql',
    database: 'nl_cl_dev',
    databases: ['information_schema', 'nl_om_dev'],
  }, 'nl_cl_dev'), true)
})

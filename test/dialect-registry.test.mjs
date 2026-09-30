import test from 'node:test'
import assert from 'node:assert/strict'
import { getDialect, getSqlDialect, registeredDialects } from '../src/host/dialects/registry.mjs'

test('dialect registry exposes stable driver and SQL contracts', () => {
  assert.deepEqual(registeredDialects(), ['mysql', 'oracle'])
  for (const id of registeredDialects()) {
    const adapter = getDialect(id)
    assert.equal(adapter.id, id)
    assert.equal(adapter.sql, getSqlDialect(id))
    for (const method of ['openCatalog', 'openQuery', 'openMaintenance', 'destroy', 'cancel', 'probe', 'prepareReadonly', 'reset']) {
      assert.equal(typeof adapter[method], 'function', `${id}.${method}`)
    }
  }
  assert.equal(getSqlDialect('mysql').limitClause(10, 20), 'LIMIT 10 OFFSET 20')
  assert.equal(getSqlDialect('oracle').limitClause(10, 20), 'OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY')
  assert.throws(() => getDialect('unknown'), /不支持/)
})

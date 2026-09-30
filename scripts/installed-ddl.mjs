import assert from 'node:assert/strict'

// The caller owns a disposable fixture; never invoke this against user databases.
export async function installedDdl({ page, dialect, schema, db, maintenance, call, run }) {
  const table = dialect === 'mysql' ? 'structure_sample' : 'STRUCTURE_SAMPLE'
  const name = s => dialect === 'mysql' ? s : s.toUpperCase()
  const plan = operations => maintenance({ kind: 'ddl-preview', schema, table, operations })
  const execute = async preview => {
    assert.equal(preview.status, 200, preview.body.error)
    const result = await maintenance({ kind: 'execute', id: preview.body.id, confirmed: true, targetName: table })
    assert.equal(result.status, 200, result.body.error)
    return result.body
  }
  const created = await execute(await plan([{ kind: 'createTable', columns: [{ name: name('id'), type: dialect === 'mysql' ? 'BIGINT' : 'NUMBER', nullable: false }] }]))
  assert.equal(created.status, 'success')
  await page.screenshot({ path: `${run}/${dialect}-ddl-created.png` })
  const dictionary = () => call('catalog', { kind: 'table', schema, table, refresh: true })
  assert.equal((await dictionary()).body.columns.length, 1)
  const added = await execute(await plan([
    { kind: 'addColumn', column: { name: name('note'), type: dialect === 'mysql' ? 'VARCHAR(80)' : 'VARCHAR2(80)', nullable: true } },
    { kind: 'comment', comment: 'installed DDL fixture' },
    { kind: 'addIndex', name: name('sample_note_idx'), columns: [name('note')] },
  ]))
  assert.deepEqual(added.steps.map(s => s.state), ['success', 'success', 'success'])
  assert.equal((await dictionary()).body.columns.length, 2)
  const insert = `INSERT INTO ${table} (${name('id')}) VALUES (1)`
  if (dialect === 'mysql') await db.query(insert)
  else await db.execute(insert, [], { autoCommit: true })
  const partial = await execute(await plan([
    { kind: 'comment', comment: 'first step committed' },
    { kind: 'addConstraint', name: name('must_exceed_ten'), type: 'check', check: { column: name('id'), operator: 'gt', value: '10' } },
    { kind: 'addColumn', column: { name: name('never_executed'), type: dialect === 'mysql' ? 'INT' : 'NUMBER', nullable: true } },
  ]))
  assert.deepEqual(partial.steps.map(s => s.state), ['success', 'failed', 'not-run'])
  assert.equal((await dictionary()).body.columns.some(c => c.name === name('never_executed')), false)
  if (dialect === 'mysql') {
    const lockedPlan = await plan([{ kind: 'comment', comment: 'must wait for fixture lock' }])
    assert.equal(lockedPlan.status, 200, lockedPlan.body.error)
    await db.beginTransaction()
    await db.query(`SELECT * FROM ${table} FOR UPDATE`)
    try {
      const locked = await execute(lockedPlan)
      assert.ok(['failed', 'unknown'].includes(locked.steps[0].state), 'Lock failure cannot report success')
    } finally { await db.rollback() }
  }
  const truncate = await plan([{ kind: 'truncateTable' }]); assert.equal(truncate.status, 200, truncate.body.error)
  assert.equal((await maintenance({ kind: 'execute', id: truncate.body.id, confirmed: true, targetName: 'wrong target' })).status, 400)
  assert.equal((await execute(truncate)).status, 'success')
  const rows = dialect === 'mysql' ? (await db.query(`SELECT * FROM ${table}`))[0] : (await db.execute(`SELECT * FROM ${table}`)).rows
  assert.equal(rows.length, 0)
  assert.equal((await maintenance({ kind: 'execute', id: truncate.body.id, confirmed: true, targetName: table })).status, 400)
  assert.equal((await execute(await plan([{ kind: 'dropTable' }]))).status, 'success')
  const tables = await call('catalog', { kind: 'tables', schema, search: table })
  assert.equal(tables.status, 200, tables.body.error)
  assert.equal(tables.body.items.some(item => item.name === table), false)
}

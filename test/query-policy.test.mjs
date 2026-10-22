import test from 'node:test'
import assert from 'node:assert/strict'
import { authorizeStatement, authorizeSelect } from '../src/host/query-policy.mjs'

test('mysql leaves locking reads for the database', async () => {
  for (const sql of [
    'SELECT * FROM (SELECT * FROM records FOR UPDATE) t',
    'SELECT * FROM records WHERE id = (SELECT id FROM records WHERE id = 1 FOR UPDATE)',
    'WITH locked AS (SELECT id FROM records FOR UPDATE) SELECT * FROM locked',
    'SELECT * FROM records FOR UPDATE',
  ]) assert.equal((await authorizeStatement('mysql', sql, 'business')).kind, 'select')
})

test('oracle leaves a parsed locking read on the readonly path and unparsed text for the database', async () => {
  assert.equal((await authorizeStatement('oracle', 'SELECT * FROM records FOR UPDATE', 'BUSINESS')).kind, 'select')
  assert.equal((await authorizeStatement('oracle', 'SELECT * FROM (SELECT * FROM records FOR UPDATE) t', 'BUSINESS')).kind, 'select')
  for (const sql of [
    'SELECT * FROM records WHERE id = (SELECT id FROM records WHERE id = 1 FOR UPDATE)',
    'WITH locked AS (SELECT id FROM records FOR UPDATE) SELECT * FROM locked',
  ]) {
    const result = await authorizeStatement('oracle', sql, 'BUSINESS')
    assert.equal(result.kind, 'write')
    assert.deepEqual(result.targets, [])
  }
})

test('MySQL read policy accepts joins, CTEs, aggregate and window functions', async () => {
  for (const sql of ['SELECT id, amount FROM records WHERE id > 1 ORDER BY id LIMIT 100', 'WITH c AS (SELECT id FROM records) SELECT COUNT(id) FROM c', 'SELECT ROW_NUMBER() OVER (ORDER BY id), COALESCE(note, \'empty\') FROM records', 'SELECT id FROM records UNION SELECT id FROM records']) {
    const result = await authorizeStatement('mysql', sql, 'business'); assert.ok(result.tables.includes('records')); assert.equal(result.kind, 'select')
  }
})

test('MySQL normal queries pass: common functions, cross-database reads', async () => {
  for (const sql of ["SELECT NOW(), IF(id > 1, 'a', 'b'), GROUP_CONCAT(name), CONCAT_WS('-', a, b), IFNULL(note, ''), DATE_ADD(checkin_date, INTERVAL 1 DAY) FROM hotels WHERE checkin_date > NOW() - INTERVAL 7 DAY", 'SELECT * FROM other.records', 'SELECT SQL_NO_CACHE id FROM records']) {
    const result = await authorizeStatement('mysql', sql, 'business'); assert.equal(result.kind, 'select')
  }
})

test('policy accepts leading line and block comments before select or write statements', async () => {
  for (const [dialect, sql, schema] of [
    ['mysql', '-- boarding_passes\nSELECT * FROM records', 'business'],
    ['mysql', '/* 说明 */ SELECT id FROM records', 'business'],
    ['mysql', '# 说明\nSELECT id FROM records', 'business'],
    ['mysql', '-- 补数据\nUPDATE records SET id = 1 WHERE id = 2', 'business'],
    ['oracle', '-- 说明\nSELECT 1 FROM DUAL', 'BUSINESS'],
  ]) assert.equal((await authorizeStatement(dialect, sql, schema)).kind, sql.includes('UPDATE') ? 'write' : 'select')
})

test('MySQL leaves parsed locking reads for the database', async () => {
  for (const sql of [
    'SELECT * FROM records FOR UPDATE',
  ]) assert.equal((await authorizeStatement('mysql', sql, 'business')).kind, 'select')
})

test('MySQL classifies file exports and executable comments as writes', async () => {
  for (const sql of [
    "SELECT * INTO OUTFILE '/tmp/x' FROM records",
    "SELECT * FROM records INTO DUMPFILE '/tmp/x'",
    "SELECT 1 /*!50000 INTO OUTFILE '/tmp/x' */",
    "SELECT 1--1 /*!50000 INTO OUTFILE '/tmp/x' */",
    'SELECT /*!50000 SLEEP(30) */ 1',
  ]) {
    assert.equal((await authorizeStatement('mysql', sql, 'business')).kind, 'write')
    await assert.rejects(authorizeSelect('mysql', sql, 'business'), /SELECT/)
  }
  for (const sql of ["SELECT '/*!50000 INTO OUTFILE */'", "SELECT 1 /* /*! ordinary comment */", 'SELECT 1 INTO @value']) {
    assert.equal((await authorizeStatement('mysql', sql, 'business')).kind, 'select')
  }
})

test('MySQL write policy admits insert, update and delete, and passes ddl to the database', async () => {
  const insert = await authorizeStatement('mysql', "INSERT INTO hotels (name, location) VALUES ('A', 'B')", 'business')
  assert.equal(insert.kind, 'write'); assert.ok(insert.tables.includes('hotels'))
  const update = await authorizeStatement('mysql', "UPDATE hotels SET price_tier = 'Luxury' WHERE id = 3", 'business')
  assert.equal(update.kind, 'write'); assert.ok(update.tables.includes('hotels'))
  const remove = await authorizeStatement('mysql', 'DELETE FROM hotels WHERE id = 3', 'business')
  assert.equal(remove.kind, 'write'); assert.deepEqual(remove.targets, [{ schema: 'business', name: 'hotels' }])
  for (const sql of ['DROP TABLE records', 'TRUNCATE TABLE records', 'ALTER TABLE records ADD c INT', 'CALL do_it()', 'SET @x = 1', 'USE other', 'CREATE TABLE t (id INT)', 'GRANT SELECT ON *.* TO u']) {
    const result = await authorizeStatement('mysql', sql, 'business')
    assert.equal(result.kind, 'write')
    assert.deepEqual(result.targets, [])
  }
})

test('MySQL write policy passes system-schema targets and still bounds sql size', async () => {
  const system = await authorizeStatement('mysql', 'UPDATE mysql.user SET Host = \'x\'', 'business')
  assert.equal(system.kind, 'write')
  assert.deepEqual(system.targets, [{ schema: 'mysql', name: 'user' }])
  await assert.rejects(authorizeStatement('mysql', 'SELECT 1 FROM ' + 'a'.repeat(20000), 'business'), /16 KiB/)
})

test('authorizeSelect keeps select-only semantics for browse and ai paths', async () => {
  assert.equal((await authorizeSelect('mysql', 'SELECT id FROM records', 'business')).kind, 'select')
  await assert.rejects(authorizeSelect('mysql', 'UPDATE records SET id = 1', 'business'), /SELECT/)
})

test('Oracle normal queries pass: package functions, cross-schema reads', async () => {
  for (const sql of ['SELECT DBMS_RANDOM.VALUE() FROM DUAL', 'SELECT * FROM OTHER.RECORDS', "SELECT id, NVL(note, 'empty') FROM RECORDS"]) {
    const result = await authorizeStatement('oracle', sql, 'BUSINESS'); assert.equal(result.kind, 'select')
  }
})

test('incomplete parser validation is sent to the database', async () => {
  for (const [dialect, sql, schema] of [
    ['mysql', 'SELECT * FORM records', 'business'],
    ['oracle', 'SELECT * FORM RECORDS', 'BUSINESS'],
  ]) {
    const result = await authorizeStatement(dialect, sql, schema)
    assert.equal(result.kind, 'write')
    assert.deepEqual(result.targets, [])
  }
  assert.equal((await authorizeStatement('mysql', "SELECT 'a;b' FROM records", 'business')).kind, 'select')
})

test('multiple statements are authorized in order and keep write confirmation', async () => {
  const mysql = await authorizeStatement('mysql', 'SELECT 1; SELECT 2', 'business')
  assert.equal(mysql.kind, 'select')
  const oracle = await authorizeStatement('oracle', 'SELECT 1 FROM DUAL; SELECT 2 FROM DUAL', 'BUSINESS')
  assert.equal(oracle.kind, 'select')
  const mixed = await authorizeStatement('mysql', 'SELECT 1; UPDATE records SET id = 1 WHERE id = 2', 'business')
  assert.equal(mixed.kind, 'write')
  assert.ok(mixed.targets.some(target => target.name === 'records'))
  const mysqlDdl = await authorizeStatement('mysql', 'SELECT 1; DROP TABLE records', 'business')
  assert.equal(mysqlDdl.kind, 'write')
  assert.deepEqual(mysqlDdl.targets, [])
  const oracleDdl = await authorizeStatement('oracle', 'SELECT 1 FROM DUAL; CREATE TABLE T (ID NUMBER)', 'BUSINESS')
  assert.equal(oracleDdl.kind, 'write')
  assert.deepEqual(oracleDdl.targets, [])
})

test('Oracle write policy admits insert, update and delete, and passes dblink and ddl to the database', async () => {
  const insert = await authorizeStatement('oracle', "INSERT INTO RECORDS (id) VALUES (1)", 'BUSINESS')
  assert.equal(insert.kind, 'write')
  const update = await authorizeStatement('oracle', "UPDATE RECORDS SET id = 2 WHERE id = 1", 'BUSINESS')
  assert.equal(update.kind, 'write')
  const remove = await authorizeStatement('oracle', 'DELETE FROM RECORDS WHERE id = 1', 'BUSINESS')
  assert.equal(remove.kind, 'write'); assert.deepEqual(remove.targets, [{ schema: 'BUSINESS', name: 'RECORDS' }])
  for (const sql of ['SELECT * FROM RECORDS@LINK', 'CREATE TABLE T (ID NUMBER)']) {
    const result = await authorizeStatement('oracle', sql, 'BUSINESS')
    assert.ok(result.kind === 'select' || result.kind === 'write')
    if (result.kind === 'write' && /CREATE/i.test(sql)) assert.deepEqual(result.targets, [])
  }
})

test('policy rejects empty sql and unknown dialects, and passes system schemas and invalid text', async () => {
  await assert.rejects(authorizeStatement('mysql', '', 'business'))
  assert.equal((await authorizeStatement('mysql', 'SELECT 1', 'information_schema')).kind, 'select')
  const invalid = await authorizeStatement('oracle', 'NOT A QUERY', 'BUSINESS')
  assert.equal(invalid.kind, 'write')
  assert.deepEqual(invalid.targets, [])
  await assert.rejects(authorizeStatement('mssql', 'SELECT 1', 'business'))
})

test('explain policy accepts EXPLAIN prefix for both dialects and returns explain kind', async () => {
  const mysql = await authorizeStatement('mysql', 'EXPLAIN SELECT * FROM records WHERE id = 1', 'business')
  assert.equal(mysql.kind, 'explain'); assert.ok(mysql.tables.includes('records'))
  assert.ok(mysql.targetSql.startsWith('SELECT'))
  const mysqlJson = await authorizeStatement('mysql', 'EXPLAIN FORMAT=JSON SELECT id FROM records', 'business')
  assert.equal(mysqlJson.kind, 'explain')
  const oracle = await authorizeStatement('oracle', 'EXPLAIN PLAN FOR SELECT * FROM RECORDS', 'BUSINESS')
  assert.equal(oracle.kind, 'explain')
  for (const dialect of ['mysql', 'oracle']) {
    const prefix = dialect === 'oracle' ? 'EXPLAIN PLAN FOR ' : 'EXPLAIN '
    for (const sql of ['INSERT INTO records (id) VALUES (1)', 'UPDATE records SET id = 2', 'DELETE FROM records']) {
      const result = await authorizeStatement(dialect, prefix + sql, 'business')
      assert.equal(result.kind, 'write')
      assert.deepEqual(result.targets, [])
    }
  }
})

test('show policy admits read-only SHOW statements about indexes and table stats', async () => {
  const idx = await authorizeStatement('mysql', 'SHOW INDEX FROM records', 'business')
  assert.equal(idx.kind, 'show'); assert.ok(idx.tables.includes('records'))
  const status = await authorizeStatement('mysql', 'SHOW TABLE STATUS FROM `business`', 'business')
  assert.equal(status.kind, 'show')
  const processlist = await authorizeStatement('mysql', 'SHOW PROCESSLIST', 'business')
  assert.equal(processlist.kind, 'write')
  assert.deepEqual(processlist.targets, [])
})

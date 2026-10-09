/** Oracle Free proves driver mechanics only; it does NOT certify Oracle 19c. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import oracle from 'oracledb'
import assert from 'node:assert/strict'
import { checkConnectionFlow } from './connection-flow.mjs'
import { checkRootRepairSql } from './root-repair-sql-probe.mjs'
const exec = promisify(execFile)
const runId = randomUUID(), password = 'Q' + randomBytes(20).toString('hex'), appPassword = 'A' + randomBytes(20).toString('hex')
const label = 'dsh.database.acceptance'
const docker = async (args, options = {}) => (await exec('docker', args, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, ...options })).stdout.trim()
const report = { startedAt: new Date().toISOString(), status: 'RUNNING', fixture: 'owned-disposable-container', image: 'gvenzl/oracle-free:23.26.2-slim', oracle19c: 'NOT_RUN', checks: [], cleanup: 'NOT_RUN', productionExecution: 'DISABLED' }
let id, admin, app, reader, writer
const executeNumberStrings = { fetchTypeHandler: metadata => metadata.dbType === oracle.DB_TYPE_NUMBER ? { type: oracle.STRING } : undefined }
try {
  id = await docker(['run', '--detach', '--label', `${label}=${runId}`, '--name', `dsh-database-oracle-${runId.slice(0, 8)}`, '--publish', '127.0.0.1::1521', '--memory', '3g', '--shm-size', '1g', '--env', 'ORACLE_PASSWORD', '--env', 'APP_USER=PROBE_APP', '--env', 'APP_USER_PASSWORD', report.image], { env: { ...process.env, ORACLE_PASSWORD: password, APP_USER_PASSWORD: appPassword } })
  assert.match(id, /^[a-f0-9]{64}$/)
  const published = await docker(['port', id, '1521/tcp']), port = Number(published.match(/127\.0\.0\.1:(\d+)/)?.[1]); assert.ok(port)
  const spec = { connectString: `127.0.0.1:${port}/FREEPDB1`, transportConnectTimeout: 2 }
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    try { app = await oracle.getConnection({ ...spec, user: 'PROBE_APP', password: appPassword }); break } catch { await delay(1000) }
  }
  assert.ok(app, 'Oracle Free fixture did not become ready within 180 seconds')
  app.callTimeout = 10000
  admin = await oracle.getConnection({ ...spec, user: 'SYSTEM', password }); admin.callTimeout = 10000
  report.serverVersion = app.oracleServerVersionString; report.thin = app.thin
  assert.ok(report.serverVersion.startsWith('23.')); assert.equal(app.thin, true)
  const identity = await app.execute("SELECT SYS_CONTEXT('USERENV', 'DB_UNIQUE_NAME'), SYS_CONTEXT('USERENV', 'SERVICE_NAME'), SYS_CONTEXT('USERENV', 'SESSION_USER') FROM DUAL")
  assert.equal(identity.rows.length, 1); report.checks.push('Real Oracle Free Thin connection, database/service/user identity')
  await app.execute('CREATE TABLE probe_records (id NUMBER(19) PRIMARY KEY, amount NUMBER(20,4), note VARCHAR2(100), created_at TIMESTAMP)')
  await app.execute("INSERT INTO probe_records VALUES (TO_NUMBER(:id), TO_NUMBER(:amount), :note, TIMESTAMP '2026-09-13 10:00:00')", { id: '9007199254740993', amount: '9007199254740993.1234', note: null }, { autoCommit: true })
  await app.execute('CREATE TABLE row_limit (id NUMBER PRIMARY KEY, value NUMBER NOT NULL)')
  await app.executeMany('INSERT INTO row_limit VALUES (:id, 0)', Array.from({ length: 101 }, (_, i) => ({ id: i + 1 })), { autoCommit: true })
  await admin.execute(`CREATE USER PROBE_READER IDENTIFIED BY "${appPassword}"`)
  await admin.execute('GRANT CREATE SESSION TO PROBE_READER')
  await admin.execute('GRANT SELECT ON PROBE_APP.PROBE_RECORDS TO PROBE_READER')
  await admin.execute('GRANT SELECT ON PROBE_APP.ROW_LIMIT TO PROBE_READER')
  await admin.execute(`CREATE USER PROBE_WRITER IDENTIFIED BY "${appPassword}"`)
  await admin.execute('GRANT CREATE SESSION TO PROBE_WRITER')
  await admin.execute('GRANT SELECT, INSERT, UPDATE, DELETE ON PROBE_APP.ROW_LIMIT TO PROBE_WRITER')
  reader = await oracle.getConnection({ ...spec, user: 'PROBE_READER', password: appPassword }); reader.callTimeout = 10000
  writer = await oracle.getConnection({ ...spec, user: 'PROBE_WRITER', password: appPassword }); writer.callTimeout = 10000
  const result = await reader.execute("SELECT id, amount, note, TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI:SS') FROM PROBE_APP.PROBE_RECORDS WHERE id = TO_NUMBER(:id)", { id: '9007199254740993' }, executeNumberStrings)
  assert.deepEqual(result.rows[0], ['9007199254740993', '9007199254740993.1234', null, '2026-09-13 10:00:00'])
  report.checks.push('Bind parameters and exact NUMBER strings with NULL/timestamp formatting')
  // Newer Oracle releases name the missing object privilege explicitly (ORA-41900).
  await assert.rejects(reader.execute('UPDATE PROBE_APP.ROW_LIMIT SET value=7 WHERE id=1'), error => [1031, 41900].includes(error.errorNum))
  report.checks.push('SELECT-only account cannot write')
  await writer.execute('SET TRANSACTION READ ONLY')
  await assert.rejects(writer.execute('UPDATE PROBE_APP.ROW_LIMIT SET value=7 WHERE id=1'), error => error.errorNum === 1456)
  await writer.rollback(); report.checks.push('Read-only transaction refuses a write-capable account')
  const update = await writer.execute('UPDATE PROBE_APP.ROW_LIMIT SET value=9 WHERE id>:id', { id: 0 }, { autoCommit: false })
  assert.equal(update.rowsAffected, 101); await writer.rollback()
  const after = await reader.execute('SELECT SUM(value) FROM PROBE_APP.ROW_LIMIT'); assert.equal(after.rows[0][0], 0)
  report.checks.push('101 direct rows detected and rolled back, independently verified')
  const small = await writer.execute('UPDATE PROBE_APP.ROW_LIMIT SET value=2 WHERE id=:id', { id: 1 }, { autoCommit: false })
  assert.equal(small.rowsAffected, 1); await writer.commit()
  const committed = await reader.execute('SELECT value FROM PROBE_APP.ROW_LIMIT WHERE id=1'); assert.equal(committed.rows[0][0], 2)
  report.checks.push('Single-row explicit commit independently verified')
  const unchanged = await writer.execute('UPDATE PROBE_APP.ROW_LIMIT SET value=2 WHERE id=:id', { id: 1 }, { autoCommit: false }); await writer.rollback()
  report.unchangedUpdateRowsAffected = unchanged.rowsAffected; assert.equal(unchanged.rowsAffected, 1)
  report.checks.push('Matched-row semantics for unchanged UPDATE')
  const empty = await reader.execute('SELECT CAST(:value AS VARCHAR2(20)) FROM DUAL', { value: '' }); assert.equal(empty.rows[0][0], null)
  report.checks.push('Empty VARCHAR2 input returns NULL; no invented empty-string distinction')
  const metadata = await reader.execute("SELECT COLUMN_NAME, DATA_TYPE FROM ALL_TAB_COLUMNS WHERE OWNER=:owner AND TABLE_NAME=:table_name ORDER BY COLUMN_ID", { owner: 'PROBE_APP', table_name: 'PROBE_RECORDS' })
  assert.equal(metadata.rows.length, 4); report.checks.push('Object-owner-aware metadata under SELECT-only user')
  const cursor = await reader.execute('SELECT id FROM PROBE_APP.ROW_LIMIT ORDER BY id', {}, { resultSet: true, prefetchRows: 0, fetchArraySize: 10 })
  try { assert.equal((await cursor.resultSet.getRows(10)).length, 10) } finally { await cursor.resultSet.close() }
  report.checks.push('ResultSet fetch is bounded and cursor can close before consuming all rows')
  writer.callTimeout = 100
  const start = Date.now()
  // PL/SQL blocks are outside phase-one SQL support; DBMS_SESSION.SLEEP did not return
  // promptly in a prior probe. Exercise ordinary query cancellation independently.
  await assert.rejects(writer.execute('SELECT SUM(SQRT(LEVEL)) FROM DUAL CONNECT BY LEVEL <= 100000000'), error => error.code === 'NJS-123')
  report.queryTimeoutElapsedMs = Date.now() - start
  assert.ok(report.queryTimeoutElapsedMs < 3000); writer.callTimeout = 10000
  assert.equal((await writer.execute('SELECT 1 FROM DUAL')).rows[0][0], 1)
  report.unsupportedPlsqlSleep = 'Prior probe returned NJS-123 but exceeded 3000ms; PL/SQL execution is excluded, callTimeout is not a whole-request deadline'
  report.checks.push('Ordinary SELECT callTimeout produces NJS-123 promptly; same connection can execute subsequent query')
  report.checks.push(await checkRootRepairSql({ name: 'root repair', dialect: 'oracle', host: '127.0.0.1', port, database: 'FREEPDB1', oracleMode: 'service', username: 'PROBE_WRITER', password: appPassword }, 'PROBE_APP',
    async (id = 1) => (await admin.execute('SELECT value FROM PROBE_APP.row_limit WHERE id=:id', { id })).rows[0][0]))
  report.checks.push(await checkConnectionFlow({ name: '', dialect: 'oracle', host: '127.0.0.1', port, database: 'FREEPDB1', oracleMode: 'service', username: 'PROBE_READER', password: appPassword, environment: 'test' }))
  report.status = 'PASS'
} catch (error) {
  report.status = 'FAIL'; report.error = { name: error.name, code: error.code || 'ASSERTION_OR_SETUP_FAILED', message: error.name === 'AssertionError' ? error.message : 'Fixture setup or database probe failed; raw errors intentionally omitted.' }; process.exitCode = 1
} finally {
  for (const connection of [reader, writer, app, admin]) await connection?.close().catch(() => {})
  if (id && /^[a-f0-9]{64}$/.test(id)) {
    const inspected = JSON.parse(await docker(['inspect', id]))[0]
    if (inspected.Id === id && inspected.Config.Labels[label] === runId) { await docker(['rm', '--force', '--volumes', id]); report.cleanup = 'PASS' }
    else { report.cleanup = 'BLOCKED_OWNERSHIP_MISMATCH'; process.exitCode = 1 }
  }
  await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/oracle-acceptance.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2))
}

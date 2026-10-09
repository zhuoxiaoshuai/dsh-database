/** Owned disposable MySQL container: no user schema or existing container is modified. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import mysql from 'mysql2/promise'
import mysqlStream from 'mysql2'
import assert from 'node:assert/strict'
import { checkConnectionFlow } from './connection-flow.mjs'
import { checkRootRepairSql } from './root-repair-sql-probe.mjs'
const exec = promisify(execFile)
const runId = randomUUID(), password = randomBytes(24).toString('hex'), readerPassword = randomBytes(24).toString('hex')
const label = 'dsh.database.acceptance', database = 'dsh_acceptance'
const docker = async (args, options = {}) => (await exec('docker', args, { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024, ...options })).stdout.trim()
const report = { startedAt: new Date().toISOString(), status: 'RUNNING', fixture: 'owned-disposable-container', target: 'MySQL 8.x', image: process.env.DSH_TEST_MYSQL_IMAGE || 'mysql:8.4.5', checks: [], cleanup: 'NOT_RUN', oracle: 'NOT_RUN', productionExecution: 'DISABLED' }
let id, admin, reader, writer
try {
  id = await docker(['run', '--detach', '--label', `${label}=${runId}`, '--name', `dsh-database-m0-${runId.slice(0, 8)}`, '--publish', '127.0.0.1::3306', '--memory', '768m', '--tmpfs', '/var/lib/mysql:rw,size=512m', '--env', 'MYSQL_ROOT_PASSWORD', '--env', `MYSQL_DATABASE=${database}`, report.image, '--innodb-buffer-pool-size=64M'], { env: { ...process.env, MYSQL_ROOT_PASSWORD: password } })
  assert.match(id, /^[a-f0-9]{64}$/)
  const published = await docker(['port', id, '3306/tcp']), port = Number(published.match(/127\.0\.0\.1:(\d+)/)?.[1]); assert.ok(port)
  const spec = { host: '127.0.0.1', port, user: 'root', password, database, connectTimeout: 2000, multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false, dateStrings: true }
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    try { admin = await mysql.createConnection(spec); break } catch { await delay(1000) }
  }
  assert.ok(admin, 'disposable MySQL did not become ready within 90 seconds')
  const [[identity]] = await admin.query('SELECT VERSION() AS version, @@server_uuid AS uuid, CURRENT_USER() AS principal, DATABASE() AS db')
  report.serverVersion = identity.version; report.identityFields = Object.keys(identity)
  assert.ok(identity.version.startsWith('8.')); report.checks.push('Real MySQL 8 identity and version probe')
  await admin.query('CREATE TABLE records (id BIGINT PRIMARY KEY, amount DECIMAL(20,4), note VARCHAR(100), created_at DATETIME) ENGINE=InnoDB')
  await admin.query('INSERT INTO records VALUES (?, ?, ?, ?)', ['9007199254740993', '9007199254740993.1234', null, '2026-09-13 10:00:00'])
  await admin.query('CREATE TABLE row_limit (id INT PRIMARY KEY, value INT NOT NULL) ENGINE=InnoDB')
  const values = Array.from({ length: 101 }, (_, i) => [i + 1, 0]); await admin.query('INSERT INTO row_limit (id, value) VALUES ?', [values])
  await admin.query('CREATE USER \'probe_reader\'@\'%\' IDENTIFIED BY ?', [readerPassword])
  await admin.query(`GRANT SELECT ON ${database}.* TO 'probe_reader'@'%'`)
  await admin.query('CREATE USER \'probe_writer\'@\'%\' IDENTIFIED BY ?', [readerPassword])
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${database}.* TO 'probe_writer'@'%'`)
  reader = await mysql.createConnection({ ...spec, user: 'probe_reader', password: readerPassword })
  writer = await mysql.createConnection({ ...spec, user: 'probe_writer', password: readerPassword })
  const [[row]] = await reader.execute('SELECT id, amount, note, created_at FROM records WHERE id = ?', ['9007199254740993'])
  assert.equal(row.id, '9007199254740993'); assert.equal(row.amount, '9007199254740993.1234'); assert.equal(row.note, null); assert.equal(row.created_at, '2026-09-13 10:00:00')
  report.checks.push('Bound parameters and string-preserving BIGINT/DECIMAL/DATETIME/NULL')
  await assert.rejects(reader.execute('UPDATE row_limit SET value = 7 WHERE id = 1'), error => error.code === 'ER_TABLEACCESS_DENIED_ERROR')
  report.checks.push('Database-enforced SELECT-only account refuses writes')
  await writer.query('SET TRANSACTION READ ONLY'); await writer.beginTransaction()
  await assert.rejects(writer.query('UPDATE row_limit SET value = 7 WHERE id = 1'), error => error.code === 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION')
  await writer.rollback(); report.checks.push('Read-only transaction refuses writes even with a write-capable fixture account')
  await writer.beginTransaction(); const [write] = await writer.execute('UPDATE row_limit SET value = 9 WHERE id > ?', [0]); assert.equal(write.affectedRows, 101); await writer.rollback()
  const [[after]] = await reader.query('SELECT SUM(value) AS total FROM row_limit'); assert.equal(Number(after.total), 0)
  report.checks.push('101 directly affected rows detected before commit; explicit rollback verified from independent session')
  await writer.beginTransaction(); const [small] = await writer.execute('UPDATE row_limit SET value = 2 WHERE id = ?', [1]); assert.equal(small.affectedRows, 1); await writer.commit()
  const [[committed]] = await reader.query('SELECT value FROM row_limit WHERE id=1'); assert.equal(committed.value, 2)
  report.checks.push('Single-row write and commit verified from independent session')
  await writer.beginTransaction(); const [unchanged] = await writer.execute('UPDATE row_limit SET value = 2 WHERE id = ?', [1]); await writer.rollback()
  report.affectedRowsMeaning = { unchangedUpdateAffectedRows: unchanged.affectedRows, changedRows: unchanged.changedRows ?? null }
  assert.equal(unchanged.affectedRows, 1); report.checks.push('Matched-row semantics recorded for unchanged UPDATE')
  await assert.rejects(reader.query('SELECT 1; SELECT 2'), error => error.code === 'ER_PARSE_ERROR')
  report.checks.push('Driver multipleStatements=false rejects script execution')
  const [metadata] = await reader.execute('SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [database, 'records'])
  assert.equal(metadata.length, 4); report.checks.push('Low-privilege table metadata discovery')
  const streamConnection = mysqlStream.createConnection({ ...spec, user: 'probe_reader', password: readerPassword })
  let count = 0
  await new Promise((resolve, reject) => {
    const stream = streamConnection.query('SELECT id FROM row_limit ORDER BY id').stream({ highWaterMark: 1 })
    stream.on('data', () => { count++; if (count === 10) { stream.destroy(); streamConnection.destroy(); resolve() } }); stream.once('error', reject)
  })
  assert.equal(count, 10); report.checks.push('Streaming rows can stop at a limit without materializing a full result array')
  const slow = await mysql.createConnection({ ...spec, user: 'probe_reader', password: readerPassword })
  const start = Date.now()
  await assert.rejects(slow.query({ sql: 'SELECT SLEEP(10)', timeout: 100 }), error => error.code === 'PROTOCOL_SEQUENCE_TIMEOUT')
  slow.destroy(); assert.ok(Date.now() - start < 3000); report.checks.push('Client timeout surfaces promptly; timed-out connection explicitly discarded (not proof of server cancellation)')
  const cancellable = await mysql.createConnection({ ...spec, user: 'probe_reader', password: readerPassword })
  const control = await mysql.createConnection({ ...spec, user: 'probe_reader', password: readerPassword })
  try {
    const [[thread]] = await cancellable.query('SELECT CONNECTION_ID() AS id')
    assert.match(String(thread.id), /^[1-9][0-9]*$/)
    // A standalone SLEEP returns 1 on interruption; a table query reports ER_QUERY_INTERRUPTED.
    const outcome = cancellable.query('SELECT id FROM row_limit WHERE SLEEP(10) = 0 LIMIT 1').then(() => null, error => error.code)
    await delay(100)
    const cancelStart = Date.now()
    await control.query(`KILL QUERY ${thread.id}`)
    assert.equal(await outcome, 'ER_QUERY_INTERRUPTED'); assert.ok(Date.now() - cancelStart < 3000)
    const [remaining] = await admin.query('SELECT ID FROM information_schema.PROCESSLIST WHERE ID = ? AND COMMAND = ?', [thread.id, 'Query'])
    assert.equal(remaining.length, 0)
    report.checks.push('Same-principal SELECT-only control connection cancels an owned query; server interruption and process state verified')
  } finally { cancellable.destroy(); control.destroy() }
  report.checks.push(await checkRootRepairSql({ name: 'root repair', dialect: 'mysql', host: spec.host, port: spec.port, database, oracleMode: 'service', username: 'probe_writer', password: readerPassword }, database,
    async (id = 1) => { const [[row]] = await admin.execute('SELECT value FROM row_limit WHERE id=?', [id]); return row.value }))
  report.checks.push(await checkConnectionFlow({ name: '', dialect: 'mysql', host: spec.host, port: spec.port, database: '', oracleMode: 'service', username: 'probe_reader', password: readerPassword, environment: 'dev' }))
  report.status = 'PASS'
} catch (error) {
  report.status = 'FAIL'; report.error = { name: error.name, code: error.code || 'ASSERTION_OR_SETUP_FAILED', stage: error.acceptanceStage, page: error.acceptancePage, message: error.name === 'AssertionError' ? error.message : 'Fixture setup or database probe failed; raw errors intentionally omitted.' }
  process.exitCode = 1
} finally {
  for (const connection of [reader, writer, admin]) connection?.destroy()
  if (id && /^[a-f0-9]{64}$/.test(id)) {
    const inspected = JSON.parse(await docker(['inspect', id]))[0]
    if (inspected.Id === id && inspected.Config.Labels[label] === runId) { await docker(['rm', '--force', id]); report.cleanup = 'PASS' }
    else { report.cleanup = 'BLOCKED_OWNERSHIP_MISMATCH'; process.exitCode = 1 }
  }
  await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/mysql-acceptance.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2))
}

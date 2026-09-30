import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { inspectSyntax } from '../experiments/parse.mjs'
const require = createRequire(import.meta.url)
const report = { recordedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`, stage: 'M0', releaseAllowed: false, drivers: {}, parsers: {}, live: {} }
for (const name of ['mysql2', 'oracledb']) {
  try {
    const module = await import(name), driver = module.default || module
    report.drivers[name] = { status: 'PASS', version: name === 'mysql2' ? require('mysql2/package.json').version : driver.versionString, ...(name === 'oracledb' ? { thin: driver.thin, thick: 'NOT_RUN' } : {}) }
  } catch (error) { report.drivers[name] = { status: 'FAIL', code: String(error.code || 'IMPORT_FAILED') } }
}
for (const dialect of ['mysql', 'oracle']) report.parsers[dialect] = inspectSyntax(dialect, 'SELECT id FROM orders WHERE id = 1')
// Explicitly named test settings only; never print connection strings or raw driver errors.
if (process.env.DSH_DATABASE_MYSQL_URL) {
  let connection
  try {
    const mysql = (await import('mysql2/promise')).default
    const url = new URL(process.env.DSH_DATABASE_MYSQL_URL)
    connection = await mysql.createConnection({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)), connectTimeout: 10000, multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false })
    const [rows] = await connection.query({ sql: 'SELECT VERSION() AS version, 1 AS probe', timeout: 10000 })
    report.live.mysql = { status: 'PASS', serverVersion: rows[0].version, query: 'read-only version probe', businessAcceptance: 'NOT_RUN' }
  } catch (error) { report.live.mysql = { status: 'FAIL', code: String(error.code || 'CONNECT_FAILED') } }
  finally { if (connection) connection.destroy() }
} else report.live.mysql = { status: 'NOT_RUN', reason: 'No explicit connection supplied to this probe; isolated container results are recorded separately in mysql-acceptance.json.' }
if (process.env.DSH_DATABASE_ORACLE_CONNECT_STRING && process.env.DSH_DATABASE_ORACLE_USER && process.env.DSH_DATABASE_ORACLE_PASSWORD) {
  let connection
  try {
    const oracle = (await import('oracledb')).default
    connection = await oracle.getConnection({ connectString: process.env.DSH_DATABASE_ORACLE_CONNECT_STRING, user: process.env.DSH_DATABASE_ORACLE_USER, password: process.env.DSH_DATABASE_ORACLE_PASSWORD, transportConnectTimeout: 10 })
    connection.callTimeout = 10000
    const result = await connection.execute('SELECT 1 FROM DUAL')
    report.live.oracle = { status: result.rows?.length === 1 ? 'PASS' : 'FAIL', serverVersion: connection.oracleServerVersionString, mode: connection.thin ? 'thin' : 'thick', businessAcceptance: 'NOT_RUN' }
  } catch (error) { report.live.oracle = { status: 'FAIL', code: String(error.code || 'CONNECT_FAILED') } }
  finally { await connection?.close().catch(() => {}) }
} else report.live.oracle = { status: 'NOT_RUN', reason: 'No explicit test connection provided; 19c is provisional, not a detected version.' }
await mkdir('artifacts', { recursive: true })
await writeFile('artifacts/m0-probe.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
if (Object.values(report.drivers).some(value => value.status !== 'PASS') || Object.values(report.parsers).some(value => !value.parsed)) process.exitCode = 1

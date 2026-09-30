import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID, randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import mysql from 'mysql2/promise'
import oracle from 'oracledb'
import { installedDdl } from './installed-ddl.mjs'
import { installedAi } from './installed-ai.mjs'
import { dismissHarnessOnboarding } from './harness-onboarding.mjs'
const exec = promisify(execFile)
const docker = async (args, env) => (await exec('docker', args, { env: env || process.env, windowsHide: true, timeout: 30000, maxBuffer: 1048576 })).stdout.trim()

/** Runs only against a new owned container. Credentials travel through memory into the real host API. */
export async function installedBusiness(page, sessionId, dialect, run) {
  const token = randomUUID(), password = 'A' + randomBytes(20).toString('hex'), label = 'dsh.database.acceptance'
  let id, db, stage = 'start disposable fixture'
  try {
    const image = dialect === 'mysql' ? 'mysql:8.4.5' : 'gvenzl/oracle-free:23.26.2-slim', internal = dialect === 'mysql' ? 3306 : 1521
    const args = ['run', '--detach', '--label', `${label}=${token}`, '--publish', `127.0.0.1::${internal}`, '--memory', dialect === 'mysql' ? '768m' : '3g']
    if (dialect === 'mysql') args.push('--tmpfs', '/var/lib/mysql:rw,size=512m', '--env', 'MYSQL_ROOT_PASSWORD', '--env', 'MYSQL_DATABASE=business', image, '--innodb-buffer-pool-size=64M')
    else args.push('--shm-size', '1g', '--env', 'ORACLE_PASSWORD', '--env', 'APP_USER=BUSINESS', '--env', 'APP_USER_PASSWORD', image)
    id = await docker(args, { ...process.env, MYSQL_ROOT_PASSWORD: password, ORACLE_PASSWORD: password, APP_USER_PASSWORD: password }); assert.match(id, /^[a-f0-9]{64}$/)
    const port = Number((await docker(['port', id, `${internal}/tcp`])).match(/127\.0\.0\.1:(\d+)/)?.[1]); assert.ok(port)
    const deadline = Date.now() + 180000
    while (Date.now() < deadline) {
      try { db = dialect === 'mysql' ? await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password, database: 'business', connectTimeout: 1000 }) : await oracle.getConnection({ user: 'BUSINESS', password, connectString: `127.0.0.1:${port}/FREEPDB1`, transportConnectTimeout: 1 }); break } catch { await delay(1000) }
    }
    assert.ok(db, `${dialect} disposable fixture did not start`)
    const schema = dialect === 'mysql' ? 'business' : 'BUSINESS', table = dialect === 'mysql' ? 'records' : 'RECORDS'
    if (dialect === 'mysql') {
      await db.query('CREATE TABLE records(id BIGINT PRIMARY KEY,amount DECIMAL(20,4),note VARCHAR(500),CONSTRAINT positive_amount CHECK(amount>0)) ENGINE=InnoDB COMMENT=\'fixture table\'')
      await db.execute('INSERT INTO records VALUES(?,?,?)', ['9007199254740993', '9007199254740993.1234', '{"id":9007199254740993,"note":"<script>no execution</script>"}'])
    } else {
      await db.execute('CREATE TABLE records(id NUMBER(19) PRIMARY KEY,amount NUMBER(20,4),note VARCHAR2(500),CONSTRAINT positive_amount CHECK(amount>0))')
      await db.execute('INSERT INTO records VALUES(TO_NUMBER(:1),TO_NUMBER(:2),:3)', ['9007199254740993', '9007199254740993.1234', '{"id":9007199254740993,"note":"<script>no execution</script>"}'], { autoCommit: true })
    }
    stage = 'installed connection and API'
    const input = { name: `${dialect} installed acceptance`, dialect, host: '127.0.0.1', port, database: dialect === 'mysql' ? schema : 'FREEPDB1', username: dialect === 'mysql' ? 'root' : 'BUSINESS', password, oracleMode: 'service', environment: 'test' }
    const api = body => page.evaluate(async ({ sessionId, body }) => { const response = await fetch('/plugins/database/connections?conversationId=' + encodeURIComponent(sessionId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() } }, { sessionId, body })
    const connected = await api({ action: 'connect', input }); assert.equal(connected.status, 200); const connection = connected.body
    assert.ok(connection.generation); assert.equal(JSON.stringify(connection).includes(password), false)
    const call = (action, input, generation = connection.generation) => api({ action, id: connection.id, generation, input })
    const schemas = await call('catalog', { kind: 'schemas' }); assert.equal(schemas.status, 200); assert.ok(schemas.body.items.some(s => s.name === schema))
    const list = await call('catalog', { kind: 'tables', schema, search: table }); assert.equal(list.status, 200); assert.ok(list.body.items.some(t => t.name === table))
    const detail = await call('catalog', { kind: 'table', schema, table }); assert.equal(detail.status, 200); assert.equal(detail.body.columns.length, 3)
    const explorerSchemas = await call('explorer-list', {}); assert.equal(explorerSchemas.status, 200)
    const schemaNode = explorerSchemas.body.nodes.find(node => node.title === schema); assert.ok(schemaNode?.ref)
    const explorerObjects = await call('explorer-list', { parent: schemaNode.ref, search: table }); assert.equal(explorerObjects.status, 200)
    const tableNode = explorerObjects.body.nodes.find(node => node.title === table); assert.ok(tableNode?.ref)
    const explorerDetail = await call('explorer-read', { ref: tableNode.ref }); assert.equal(explorerDetail.status, 200); assert.equal(explorerDetail.body.columns.length, 3)
    assert.equal((await call('explorer-list', {}, 'stale-generation')).status, 400)
    if (dialect === 'mysql') {
      const indexes = await call('catalog', { kind: 'indexes', schema, table }); assert.equal(indexes.status, 200); assert.equal(indexes.body.indexes.status, 'actual')
    } else {
      assert.equal(detail.body.indexes.status, 'actual'); assert.ok(detail.body.constraints.values.length >= 2)
    }
    const summary = await call('catalog', { kind: 'schema', schema }); assert.equal(summary.status, 200)
    if (dialect === 'oracle') assert.equal(summary.body.storage.status, 'unavailable', 'No DBA_SEGMENTS permission must remain unavailable, not zero')
    const queried = await call('query', { schema, sql: 'SELECT id,amount,note FROM records' }); assert.equal(queried.status, 200, queried.body.error); assert.deepEqual(queried.body.rows[0].slice(0, 2), ['9007199254740993', '9007199254740993.1234'])
    assert.equal((await call('query', { schema, sql: 'DROP TABLE records' })).status, 400, 'DDL must remain behind maintenance approval')
    assert.equal((await call('catalog', { kind: 'tables', schema }, 'stale-generation')).status, 400)
    // Remount the actual plugin after a page reload, then use the object list and SQL tab.
    stage = 'installed workbench UI'
    await page.reload()
    await dismissHarnessOnboarding(page)
    await page.locator('[data-sidebar-right-session]:not([hidden])').first().waitFor({ state: 'attached', timeout: 20000 })
    if (!await page.locator('.db-object-home').isVisible()) await page.getByRole('button', { name: '打开数据库工作台', exact: true }).first().click()
    await page.locator('.db-object-home').waitFor({ timeout: 20000 })
    await page.locator('.db-object-list').getByText(table, { exact: true }).waitFor({ timeout: 20000 })
    await page.locator('.db-object-list').getByText(table, { exact: true }).click()
    await page.getByRole('button', { name: '打开表', exact: true }).click()
    await page.locator('.db-data-grid').waitFor({ timeout: 30000 })
    assert.ok((await page.locator('.db-data-grid').innerText()).includes('9007199254740993.1234'))
    await page.locator('.db-object-tab').getByRole('button', { name: '字段', exact: true }).click()
    await page.locator('.db-meta-pane').waitFor({ timeout: 20000 })
    await page.getByRole('button', { name: '新建查询', exact: true }).click()
    await page.locator('.db-sql-editor .cm-content').fill('SELECT id,amount,note FROM records')
    await page.getByRole('button', { name: '运行', exact: true }).click()
    await page.locator('.db-sql-tab .db-data-grid').waitFor({ timeout: 30000 })
    assert.ok((await page.locator('.db-sql-tab .db-data-grid').innerText()).includes('9007199254740993.1234'))
    await page.locator('.db-sql-tab .db-data-grid tbody td').last().click()
    await page.getByRole('button', { name: '展开字段详情', exact: true }).click()
    assert.ok((await page.locator('.db-cell-detail').innerText()).includes('9007199254740993'))
    assert.equal(await page.locator('.db-cell-detail script').count(), 0)
    stage = 'installed AI execution UI'
    const aiCheck = await installedAi(page, sessionId, connection)
    await page.getByRole('button', { name: 'AI Query', exact: true }).click()
    for (const width of [420, 768, 1200]) { await page.setViewportSize({ width, height: 980 }); await page.screenshot({ path: `${run}/${dialect}-${width}.png` }) }
    await page.setViewportSize({ width: 1440, height: 980 })
    // Complete metadata privileges are required for trigger/cascade qualification.
    // Grant them only to this disposable fixture account after verifying the unavailable-state UI.
    if (dialect === 'oracle') {
      const admin = await oracle.getConnection({ user: 'SYSTEM', password, connectString: `127.0.0.1:${port}/FREEPDB1` })
      try { await admin.execute('GRANT SELECT ANY DICTIONARY TO BUSINESS') } finally { await admin.close() }
    }
    stage = 'installed maintenance API and UI'
    const maintenance = data => call('maintenance', data)
    assert.equal((await maintenance({ kind: 'preview', schema, table, operation: { kind: 'insert', values: {} } })).status, 400, 'New connection must remain read-only until human enable')
    assert.equal((await maintenance({ kind: 'enable', enabled: true })).status, 200)
    const name = s => dialect === 'mysql' ? s : s.toUpperCase()
    const values = { [name('id')]: '2', [name('amount')]: '1.2300', [name('note')]: 'original' }
    const preview = await maintenance({ kind: 'preview', schema, table, operation: { kind: 'insert', values } })
    assert.equal(preview.status, 200, preview.body.error)
    const saved = await maintenance({ kind: 'execute', id: preview.body.id, confirmed: true, sql: 'DELETE FROM records', params: [] })
    assert.equal(saved.status, 200, saved.body.error); assert.equal(saved.body.status, 'success')
    assert.equal((await maintenance({ kind: 'execute', id: preview.body.id, confirmed: true })).status, 400, 'Approval is single-use')
    const browse = await call('browse', { schema, table, page: 0, filters: [{ column: name('id'), operator: 'eq', value: '2' }] })
    assert.equal(browse.status, 200, browse.body.error); assert.equal(browse.body.rows.length, 1)
    const original = Object.fromEntries(browse.body.columns.map((c, i) => [c, browse.body.rows[0][i]]))
    const change = await maintenance({ kind: 'preview', schema, table, operation: { kind: 'update', original, values: { [name('note')]: 'my draft' } } })
    assert.equal(change.status, 200, change.body.error)
    if (dialect === 'mysql') await db.execute("UPDATE records SET note='other session' WHERE id=2")
    else await db.execute("UPDATE records SET note='other session' WHERE id=2", [], { autoCommit: true })
    const conflict = await maintenance({ kind: 'execute', id: change.body.id, confirmed: true }); assert.equal(conflict.status, 400); assert.ok(conflict.body.error.includes('回滚'))
    const readBack = dialect === 'mysql' ? (await db.query('SELECT note FROM records WHERE id=2'))[0][0].note : (await db.execute('SELECT note FROM records WHERE id=2')).rows[0][0]
    assert.equal(readBack, 'other session', 'Independent session must see the concurrent update unchanged')
    await page.getByRole('tab', { name: `${schema}.${table}`, exact: true }).click()
    await page.getByRole('button', { name: '数据', exact: true }).click()
    await page.locator('.db-object-tab').getByRole('button', { name: '开启维护', exact: true }).click()
    await installedDdl({ page, dialect, schema, db, maintenance, call, run })
    const replacement = await api({ action: 'update', id: connection.id, input }); assert.equal(replacement.status, 200); assert.notEqual(replacement.body.generation, connection.generation)
    assert.equal((await call('query', { schema, sql: 'SELECT id FROM records' })).status, 400)
    assert.equal((await api({ action: 'remove', id: connection.id })).status, 200)
    return `${dialect}: installed tgz host API and UI verified catalog, object home open table, columns pane, SQL tab execute, exact numbers, JSON cell preview, AI execution tab, stale generation, connection edit/delete, DML insert/update/delete/conflict rollback/single-use approval, DDL create/add/index/comment/partial failure/truncate/drop${dialect === 'mysql' ? '/lock wait' : ''}, 420/768/1200 screenshots; disposable fixture only; ${aiCheck}`
  } catch (error) {
    error.acceptanceStage = `${dialect}: ${stage}`
    if (stage === 'installed maintenance API and UI') error.acceptanceDebug = await page.evaluate(() => {
      const button = [...document.querySelectorAll('.db-object-tab .db-maintenance-toggle')].find(node => node.textContent?.includes('开启维护'))
      if (!button) return { button: 'missing' }
      const rect = button.getBoundingClientRect(), parent = button.closest('.db-query-result-actions')
      const atCenter = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return { button: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, parent: parent ? { scrollLeft: parent.scrollLeft, scrollWidth: parent.scrollWidth, clientWidth: parent.clientWidth } : null, atCenter: atCenter?.className || atCenter?.tagName }
    }).catch(() => null)
    throw error
  } finally {
    if (dialect === 'mysql') await db?.end().catch(() => {}); else await db?.close().catch(() => {})
    if (id) { const info = JSON.parse(await docker(['inspect', id]))[0]; assert.equal(info.Id, id); assert.equal(info.Config.Labels[label], token); await docker(['rm', '--force', '--volumes', id]) }
  }
}

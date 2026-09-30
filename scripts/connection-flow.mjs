import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { startPreview } from './preview.mjs'
import { ConnectionService } from '../src/connection-service.ts'

/** Invoked only by owned-container acceptance; never prints or stores credentials. */
export async function checkConnectionFlow(input) {
  const { server, url } = await startPreview()
  const browser = await chromium.launch({ channel: process.env.DSH_TEST_BROWSER || 'chrome', headless: true })
  const page = await browser.newPage()
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  const storageDirectory = await mkdtemp(resolve(tmpdir(), 'dsh-database-flow-'))
  const service = new ConnectionService(session => session === 'a' || session === 'b', storageDirectory)
  let stage = 'open connection form'
  try {
    assert.equal((await fetch(new URL('/api/database/connections', url))).status, 403)
    await page.goto(url)
    const endpoint = '/api/database/connections'
    const list = () => page.evaluate(async endpoint => (await (await fetch(endpoint)).json()).connections, endpoint)
    // Catalog discovery can finish while an edit dialog is open; it is not a connection edit.
    const profile = ({ workbench: _workbench, databases: _databases, ...connection }) => connection
    await page.getByRole('button', { name: '添加连接', exact: true }).click()
    stage = 'choose database type'
    const form = page.getByRole('dialog', { name: '新建数据库连接' })
    await form.locator('.db-connection-pick-card').filter({ hasText: input.dialect === 'oracle' ? 'Oracle' : 'MySQL' }).click()
    stage = 'fill connection form'
    await form.getByLabel('主机地址', { exact: true }).fill(input.host)
    await form.getByLabel('端口', { exact: true }).fill(String(input.port))
    if (input.dialect === 'oracle') await form.getByLabel('Service Name', { exact: true }).fill(input.database)
    // MySQL intentionally leaves optional database/name empty.
    await form.getByLabel('用户名', { exact: true }).fill(input.username)
    await form.getByLabel('密码', { exact: true }).fill(input.password + '-wrong')
    await form.getByRole('button', { name: '测试连接', exact: true }).click()
    stage = 'reject invalid credentials'
    await form.getByRole('status').filter({ hasText: /认证失败|Oracle 连接失败/ }).waitFor({ timeout: 20000 })
    assert.equal((await list()).length, 0)
    await form.getByLabel('密码', { exact: true }).fill(input.password)
    await form.getByRole('button', { name: '测试连接', exact: true }).click()
    stage = 'test valid credentials'
    await form.getByRole('status').filter({ hasText: '连接测试成功' }).waitFor({ timeout: 20000 })
    assert.equal((await list()).length, 0, 'test must not retain a connection')
    assert.equal((await form.getByLabel('密码', { exact: true }).getAttribute('type')), 'password')
    await form.getByRole('button', { name: '连接', exact: true }).click()
    stage = 'connect and close form'
    await form.waitFor({ state: 'hidden', timeout: 20000 })
    const connections = await list(); assert.equal(connections.length, 1)
    let connection = connections[0]
    assert.equal(connection.live, true); assert.equal(connection.dialect, input.dialect)
    assert.equal(JSON.stringify(connection).includes(input.password), false)
    assert.ok(connection.name.includes(input.host)); assert.ok(connection.version)
    assert.ok((await page.locator('.db-tree-conn .db-tree-row.is-selected').innerText()).includes(connection.name))
    await page.getByRole('region', { name: '真实数据库对象' }).count() // catalog is checked through the installed plugin suite
    await page.getByRole('button', { name: `更多 ${connection.name} 操作`, exact: true }).click()
    await page.getByRole('menu').getByRole('button', { name: '编辑', exact: true }).click()
    stage = 'edit connection'
    const editing = page.getByRole('dialog', { name: '编辑数据库连接' })
    assert.equal(await editing.getByLabel('主机地址', { exact: true }).inputValue(), input.host)
    assert.equal(await editing.getByLabel('用户名', { exact: true }).inputValue(), input.username)
    assert.equal(await editing.getByLabel('密码', { exact: true }).inputValue(), '')
    await editing.getByLabel('连接名称 · 可选', { exact: true }).fill('Edited connection')
    await editing.getByLabel('密码', { exact: true }).fill(input.password + '-wrong')
    await editing.getByRole('button', { name: '保存并重连', exact: true }).click()
    stage = 'reject invalid edited credentials'
    await editing.getByRole('status').filter({ hasText: /认证失败|Oracle 连接失败/ }).waitFor({ timeout: 20000 })
    assert.deepEqual((await list()).map(profile), connections.map(profile), 'failed edit must leave original connection unchanged')
    await editing.getByLabel('密码', { exact: true }).fill(input.password)
    await editing.getByRole('button', { name: '测试连接', exact: true }).click()
    stage = 'test edited credentials'
    await editing.getByRole('status').filter({ hasText: '连接测试成功' }).waitFor({ timeout: 20000 })
    assert.deepEqual((await list()).map(profile), connections.map(profile), 'test edit must not modify original')
    await editing.getByRole('button', { name: '保存并重连', exact: true }).click()
    stage = 'save edited connection'
    await editing.waitFor({ state: 'hidden', timeout: 20000 })
    const updated = await list(); assert.equal(updated.length, 1)
    assert.equal(updated[0].id, connection.id); assert.equal(updated[0].name, 'Edited connection')
    assert.equal('password' in updated[0].settings, false)
    connection = updated[0]
    await page.reload()
    stage = 'reload and delete connection'
    await page.getByRole('button', { name: `更多 ${connection.name} 操作`, exact: true }).click()
    await page.getByRole('menu').getByRole('button', { name: '删除', exact: true }).click()
    await page.getByRole('dialog', { name: '删除数据库连接', exact: true }).getByRole('button', { name: '删除连接', exact: true }).click()
    await page.waitForFunction(async endpoint => (await (await fetch(endpoint)).json()).connections.length === 0, endpoint)
    const cookie = (await page.context().cookies())[0]
    const forged = await fetch(new URL(endpoint, url), { method: 'POST', headers: { Cookie: `${cookie.name}=${cookie.value}`, Origin: 'http://untrusted.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'test', input }) })
    assert.equal(forged.status, 403)
    const retained = await service.open('a', input, false)
    assert.ok(service.list('b').some(row => row.id === retained.id), 'workspace connections are shared across valid conversations')
    assert.throws(() => service.list('not-allowed'))
    await assert.rejects(service.remove('not-allowed', retained.id))
    await assert.rejects(service.update('not-allowed', retained.id, input))
    if (input.dialect === 'mysql') {
      for (let i = 0; i < 3; i++) await service.open('a', input, false)
      await service.update('a', retained.id, { ...input, name: 'Edit at connection limit' })
      assert.equal(service.list('a').length, 4)
    }
    const changed = service.update('a', retained.id, input)
    const rejected = assert.rejects(changed)
    await service.remove('a', retained.id)
    await rejected
    assert.equal(service.list('a').some(c => c.id === retained.id), false, 'delete during edit cannot resurrect connection')
    assert.deepEqual(errors, [])
    return 'Browser connect/edit/test/save/delete verified; failed edits preserve original; update keeps ID without password disclosure; workspace sharing, invalid sessions and deleted-target resurrection verified'
  } catch (error) {
    error.acceptanceStage = stage
    error.acceptancePage = {
      buttons: (await page.getByRole('button').allTextContents()).map(value => value.trim()).filter(Boolean).slice(0, 16),
      statuses: (await page.getByRole('status').allTextContents()).map(value => value.replaceAll(input.password, '[REDACTED]').trim().slice(0, 220)).filter(Boolean).slice(0, 4),
      pageErrors: errors.slice(0, 3).map(value => value.slice(0, 200)),
    }
    throw error
  } finally { await service.dispose(); await rm(storageDirectory, { recursive: true, force: true }); await browser.close(); await new Promise(resolve => server.close(resolve)) }
}

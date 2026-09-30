import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

const exec = promisify(execFile)
const docker = async args => (await exec('docker', args, { windowsHide: true, timeout: 30000, maxBuffer: 1048576 })).stdout.trim()

/** Real installed DSH/Web UI against an owned, disposable Redis instance. */
export async function installedRedis(page, sessionId) {
  const marker = randomUUID(), label = 'dsh.database.redis.acceptance'
  let id, stage = 'start Redis fixture'
  try {
    id = await docker(['run', '--detach', '--label', `${label}=${marker}`, '--publish', '127.0.0.1::6379', 'redis:alpine', 'redis-server', '--save', '', '--appendonly', 'no'])
    assert.match(id, /^[a-f0-9]{64}$/)
    const port = Number((await docker(['port', id, '6379/tcp'])).match(/127\.0\.0\.1:(\d+)/)?.[1])
    assert.ok(port)
    const api = body => page.evaluate(async ({ sessionId, body }) => {
      const response = await fetch('/plugins/database/connections?conversationId=' + encodeURIComponent(sessionId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return { status: response.status, body: await response.json() }
    }, { sessionId, body })
    const input = { name: 'Redis Web acceptance', dialect: 'redis', host: '127.0.0.1', port, database: '0', oracleMode: 'service', username: '', password: '', environment: 'sit', tls: false }
    stage = 'new Redis connection form'
    await page.getByRole('button', { name: '添加连接', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '新建数据库连接' })
    await dialog.locator('.db-connection-pick-card').filter({ hasText: 'Redis' }).click()
    await dialog.getByLabel('连接名称 · 可选').fill('Redis Web acceptance')
    await dialog.getByLabel('主机地址').fill('127.0.0.1')
    await dialog.getByLabel('端口').fill(String(port))
    await dialog.getByLabel('DB 编号').fill('0')
    await dialog.getByRole('button', { name: '连接', exact: true }).click()
    const redis = page.locator('[aria-label="Redis 工作区"]')
    await redis.waitFor({ timeout: 15000 })
    stage = 'Redis command and Key browser'
    await redis.getByRole('tab', { name: '命令台' }).click()
    const commandEditor = redis.getByLabel('Redis 命令')
    await commandEditor.fill('PI')
    await page.locator('.cm-tooltip-autocomplete li').filter({ hasText: 'PING' }).first().waitFor()
    await commandEditor.press('Enter')
    assert.equal(await commandEditor.textContent(), 'PING')
    await commandEditor.press('ControlOrMeta+Enter')
    await redis.getByText('PONG', { exact: false }).first().waitFor()
    await commandEditor.fill('SET dsh:web:fixture ready')
    await redis.getByRole('button', { name: '执行', exact: true }).click()
    stage = 'Redis Key completion on installed Web'
    await commandEditor.fill('GET dsh:web:fi')
    await page.locator('.cm-tooltip-autocomplete li').filter({ hasText: 'dsh:web:fixture' }).first().waitFor({ timeout: 10000 })
    await commandEditor.press('Enter')
    assert.equal(await commandEditor.textContent(), 'GET dsh:web:fixture')
    await commandEditor.press('ControlOrMeta+Enter')
    await redis.getByText('ready', { exact: true }).first().waitFor()
    assert.match(await redis.locator('.db-command-hint').textContent(), /中文|读取|Key/)
    stage = 'Redis Key browser'
    await redis.getByRole('tab', { name: '总览' }).click()
    const keyDrawerButton = redis.getByRole('button', { name: '打开 Key 列表' })
    if (await keyDrawerButton.isVisible()) await keyDrawerButton.click()
    await redis.getByRole('textbox', { name: '搜索 Key' }).fill('dsh:web:*')
    await redis.getByRole('button', { name: '重新扫描' }).click()
    await redis.locator('.db-search-tree-body button[title="dsh:web:fixture"]').click()
    await redis.getByText('String', { exact: true }).waitFor()
    await redis.locator('.db-redis-key-toolbar').getByText(/^TTL /).waitFor()
    const listed = await api({ action: 'execution-list' })
    assert.equal(listed.status, 200)
    const manual = listed.body.items.filter(item => item.initiator === 'user' && item.operation === 'redis_execute' && item.connectionName === 'Redis Web acceptance')
    assert.equal(manual.length, 3, 'PING, SET and GET each create one manual execution record')
    assert.deepEqual(manual.map(item => item.title).sort(), ['Redis GET', 'Redis PING', 'Redis SET'])
    assert.ok(!JSON.stringify(manual).includes('dsh:web:fixture'), 'history must not persist command arguments')
    assert.ok(manual.every(item => item.resultPersisted === false))
    const connection = (await page.evaluate(async sessionId => (await (await fetch('/plugins/database/connections?conversationId=' + encodeURIComponent(sessionId))).json()).connections, sessionId)).find(item => item.name === 'Redis Web acceptance')
    assert.ok(connection?.generation)
    const mismatch = await api({ action: 'catalog', id: connection.id, generation: connection.generation, input: { kind: 'schemas' } })
    assert.notEqual(mismatch.status, 200)
    stage = 'Redis shared AI document'
    await redis.getByRole('tab', { name: 'AI Query' }).click()
    await redis.getByLabel('Redis 命令').fill('PING')
    await redis.getByRole('button', { name: '执行当前内容', exact: true }).first().click()
    await redis.getByText('PONG', { exact: false }).first().waitFor()
    await redis.getByRole('button', { name: '归还 AI' }).click()
    stage = 'Redis shared knowledge'
    await redis.getByRole('tab', { name: '经验库' }).click()
    await redis.getByLabel('Redis 命令').fill('GET dsh:web:fixture')
    await redis.getByLabel('标题').fill('Redis fixture GET')
    await redis.getByRole('button', { name: '保存', exact: true }).click()
    await redis.getByText('Redis fixture GET', { exact: true }).first().waitFor()
    await redis.getByRole('tab', { name: '命令台' }).click()
    await commandEditor.fill('FLUSHDB')
    await redis.getByRole('button', { name: '执行', exact: true }).click()
    return 'Redis installed Web UI: connection form, command, SCAN, Key details, AI document, knowledge, history and SQL/Redis isolation passed'
  } catch (error) {
    error.acceptanceStage = stage
    if (stage === 'Redis Key completion on installed Web') {
      error.acceptanceDebug = await page.evaluate(async sessionId => {
        const base = '/plugins/database/connections?conversationId=' + encodeURIComponent(sessionId)
        const listed = await (await fetch(base)).json()
        const connection = listed.connections?.find(item => item.name === 'Redis Web acceptance')
        let suggest
        if (connection) {
          const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'redis-key-suggest', id: connection.id, generation: connection.generation, input: { prefix: 'dsh:web:fi' } }) })
          const body = await response.json().catch(() => ({}))
          suggest = { status: response.status, count: Array.isArray(body.keys) ? body.keys.length : undefined, error: String(body.error || '').slice(0, 120) }
        }
        return { live: connection?.live, generationPresent: !!connection?.generation, suggest,
          hint: document.querySelector('.db-command-hint')?.textContent?.slice(0, 200),
          tooltips: [...document.querySelectorAll('.cm-tooltip-autocomplete li')].map(node => node.textContent?.slice(0, 80)).slice(0, 8) }
      }, sessionId).catch(() => ({ unavailable: true }))
    }
    throw error
  } finally {
    if (id) await docker(['rm', '--force', id]).catch(() => {})
  }
}

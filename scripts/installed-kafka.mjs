import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Kafka, logLevel } from 'kafkajs'
import { withKafkaFixture } from './kafka-fixture.mjs'

/** Installed DSH Web flow against a fixture owned by this run. */
export async function installedKafka(page, sessionId) {
  let stage = '创建一次性 Kafka fixture'
  try {
    return await withKafkaFixture(async ({ brokers }) => {
      const kafka = new Kafka({ clientId: 'dsh-installed-kafka-fixture', brokers, logLevel: logLevel.ERROR })
      const admin = kafka.admin(), producer = kafka.producer()
      const topic = `dsh_web_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      const command = `PEEK ${JSON.stringify(topic)} PARTITION 0 FROM BEGINNING LIMIT 20`
      try {
        await admin.connect()
        await admin.createTopics({ topics: [{ topic, numPartitions: 1, replicationFactor: 1 }], waitForLeaders: true })
        await producer.connect()
        await producer.send({ topic, messages: [{ key: 'web', value: 'kafka-web-fixture' }] })
        stage = 'Kafka 连接表单'
        const emptyAdd = page.getByRole('button', { name: '添加连接', exact: true })
        if (await emptyAdd.isVisible()) await emptyAdd.click()
        else await page.getByRole('button', { name: '新建连接', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: '新建数据库连接' })
        await dialog.locator('.db-connection-pick-card').filter({ hasText: 'Kafka' }).click()
        await dialog.getByLabel('Broker 地址 · 每行一个').fill(brokers[0])
        await dialog.getByRole('button', { name: '连接', exact: true }).click()
        const workspace = page.locator('[aria-label="Kafka 工作区"]')
        await workspace.waitFor({ timeout: 15000 })
        stage = 'Kafka Topic 总览'
        const topicToggle = workspace.getByRole('button', { name: '打开 Topic 列表' })
        if (await topicToggle.isVisible()) await topicToggle.click()
        await workspace.getByText(topic, { exact: true }).first().click()
        await workspace.getByRole('columnheader', { name: '副本' }).waitFor()
        await workspace.getByRole('button', { name: '0', exact: true }).first().waitFor()
        stage = 'Kafka 公共查询窗口'
        await workspace.getByRole('tab', { name: '查询' }).click()
        const editor = workspace.getByLabel('Kafka 命令')
        await editor.fill(command)
        await editor.press('ControlOrMeta+Enter')
        await workspace.getByText('kafka-web-fixture', { exact: false }).first().waitFor({ timeout: 15000 })
        stage = 'Kafka 执行记录'
        const api = body => page.evaluate(async ({ sessionId, body }) => {
          const response = await fetch('/plugins/database/connections?conversationId=' + encodeURIComponent(sessionId), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          return { status: response.status, body: await response.json() }
        }, { sessionId, body })
        const listed = await api({ action: 'execution-list' })
        assert.equal(listed.status, 200)
        assert.ok(listed.body.items.some(item => item.dialect === 'kafka' && item.operation === 'kafka_peek'))
        assert.ok(!JSON.stringify(listed.body.items).includes('kafka-web-fixture'))
        stage = 'Kafka AI 共编与接管'
        await workspace.getByRole('tab', { name: 'AI Query' }).click()
        await workspace.getByRole('button', { name: '接管' }).click()
        await workspace.getByLabel('Kafka 命令').fill(command)
        await workspace.getByRole('button', { name: '执行当前内容' }).click()
        await workspace.getByText('kafka-web-fixture', { exact: false }).first().waitFor({ timeout: 15000 })
        await workspace.getByRole('button', { name: '归还 AI' }).click()
        stage = 'Kafka 经验库'
        await workspace.getByRole('tab', { name: '经验库' }).click()
        await workspace.getByLabel('Kafka 命令').fill(command)
        await workspace.getByRole('button', { name: '保存', exact: true }).click()
        await workspace.getByText('PEEK', { exact: false }).first().waitFor({ timeout: 10000 })
        return 'Kafka installed Web: connection, Topic, bounded PEEK, history, AI document and knowledge passed'
      } finally {
        await producer.disconnect().catch(() => {})
        await admin.deleteTopics({ topics: [topic] }).catch(() => {})
        await admin.disconnect().catch(() => {})
      }
    })
  } catch (error) {
    error.acceptanceStage = stage
    throw error
  }
}

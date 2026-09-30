import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SqlTemplateStore } from '../src/host/sql-template-store.ts'
import { temporaryDirectory } from './helpers.mjs'

test('legacy SQL templates migrate once while Redis knowledge shares the new store', async t => {
  const root = temporaryDirectory(t, 'knowledge-')
  const connectionId = '11111111-1111-4111-8111-111111111111'
  const previous = new SqlTemplateStore(root)
  const sql = await previous.publish({ sql: 'SELECT 1', dialect: 'mysql', connectionId, title: '旧 SQL', action: 'create' })
  const legacy = join(root, 'sql-templates.json')
  const newFile = join(root, 'knowledge.json')
  const historical = readFileSync(newFile, 'utf8')
  writeFileSync(legacy, JSON.stringify({ version: 1, templates: JSON.parse(historical).templates }))
  const { rmSync } = await import('node:fs')
  rmSync(newFile)
  const migrated = new SqlTemplateStore(root)
  assert.equal(migrated.get(sql.id)?.id, sql.id)
  const command = migrated.publishKnowledge({ sourceId: 'redis', connectionId, text: 'GET customer:1', title: '查看客户' })
  assert.equal(command.sourceId, 'redis')
  assert.equal(existsSync(legacy), true)
  assert.equal(readFileSync(legacy, 'utf8'), JSON.stringify({ version: 1, templates: JSON.parse(historical).templates }))
  const reopened = new SqlTemplateStore(root)
  assert.equal(reopened.get(sql.id)?.id, sql.id)
  assert.equal(reopened.searchKnowledge('redis', connectionId).length, 1)
  assert.equal(reopened.publishKnowledge({ sourceId: 'redis', connectionId, text: 'GET customer:1', title: '更新' }).id, command.id)
  assert.equal(reopened.searchKnowledge('redis', connectionId).length, 1)
})

test('Redis knowledge is connection-bound, versioned and rejects known credentials', t => {
  const root = temporaryDirectory(t, 'knowledge-')
  const store = new SqlTemplateStore(root)
  const first = store.publishKnowledge({ sourceId: 'redis', connectionId: 'a', text: 'GET "my key"' })
  assert.equal(store.searchKnowledge('redis', 'b').length, 0)
  assert.equal(store.getKnowledge('redis', first.id, 'b'), undefined)
  assert.throws(() => store.publishKnowledge({ sourceId: 'redis', connectionId: 'a', id: first.id, expectedVersion: 9, text: 'GET other' }), /已更新/)
  const second = store.publishKnowledge({ sourceId: 'redis', connectionId: 'a', id: first.id, expectedVersion: 1, text: 'GET other' })
  assert.equal(second.version, 2)
  assert.throws(() => store.publishKnowledge({ sourceId: 'redis', connectionId: 'a', text: 'AUTH user password' }), /凭据/)
  assert.throws(() => store.publishKnowledge({ sourceId: 'redis', connectionId: 'a', text: 'ACL SETUSER user >password' }), /凭据/)
  store.archiveKnowledge('redis', first.id, 'a')
  assert.equal(store.searchKnowledge('redis', 'a').length, 0)
})

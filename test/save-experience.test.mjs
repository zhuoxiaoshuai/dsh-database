import test from 'node:test'
import assert from 'node:assert/strict'
import { publishExperienceFromSql } from '../src/shared/publish-experience.ts'

test('publishExperienceFromSql saves in one fromSql round-trip and reports merge', async () => {
  const calls = []
  const bridge = {
    templates: async (action, body) => {
      calls.push([action, body])
      if (action === 'template-publish') return { id: 'existing', merged: true }
      throw new Error(`unexpected ${action}`)
    },
  }
  const outcome = await publishExperienceFromSql(bridge, { sql: 'SELECT 1', dialect: 'mysql', connectionId: 'c1', title: 'Name' })
  assert.equal(outcome.id, 'existing')
  assert.equal(outcome.merged, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'template-publish')
  assert.equal(calls[0][1].publishAction, 'fromSql')
})

test('publishExperienceFromSql creates when host reports a new id', async () => {
  const bridge = {
    templates: async (action, body) => {
      if (action === 'template-publish') {
        assert.equal(body.publishAction, 'fromSql')
        return { id: 'created', merged: false }
      }
      throw new Error(`unexpected ${action}`)
    },
  }
  const outcome = await publishExperienceFromSql(bridge, { sql: 'SELECT 2', dialect: 'mysql', connectionId: 'c1', title: 'Fresh' })
  assert.equal(outcome.id, 'created')
  assert.equal(outcome.merged, false)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8')

test('inactive workbench tabs keep mounted state but gate background effects', () => {
  const pane = source('../src/client/sql/workspace-bindings.tsx')
  const frame = source('../src/client/workspace/source/source-workspace.tsx')
  const object = source('../src/client/object-workspace.tsx')
  const sql = source('../src/client/sql-workspace-tab.tsx')
  const ai = source('../src/client/ai-collab-pane.tsx')
  assert.ok(pane.includes('active={isActive}'))
  assert.ok(pane.includes('hidden={!isActive}'))
  assert.ok(pane.includes('keepMounted: true'))
  assert.ok(frame.includes('hidden={item.id !== navigation.active}'))
  assert.ok(object.includes('if (!active || !connection.live)'))
  assert.ok(sql.includes('if (active && connection.live && schema)'))
  assert.ok(ai.includes('if (active && connection.live && query.schema)'))
})

test('AI hydration is single-flight and aborts its long poll', () => {
  const bus = source('../src/client/ai-query-bus.ts')
  assert.ok(bus.includes('recovering.current?.key === requestKey'))
  assert.ok(bus.includes('keyRef.current !== requestKey'))
  assert.ok(bus.includes("'execution-wait', { revision: seen }, shared.controller.signal"))
  assert.ok(bus.includes('shared.controller.abort()'))
  assert.ok(bus.includes('subscriptions = new WeakMap'))
})

test('all SQL entries validate Host authorization and use the trusted initiator lane in the worker', () => {
  const worker = source('../src/host/connection-worker.mjs')
  assert.ok(worker.includes('function trustedAuthorization'))
  assert.ok(worker.includes('trustedAuthorization(message.authorized, rest.sql)'))
  assert.ok(worker.includes("message.lane === 'manual' || message.action === 'manual-query' ? 'manual' : 'query'"))
})

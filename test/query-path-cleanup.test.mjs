import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8')

test('inactive workbench tabs keep mounted state but gate background effects', () => {
  const pane = source('../src/client/active-connection-pane.tsx')
  const object = source('../src/client/object-workspace.tsx')
  const sql = source('../src/client/sql-workspace-tab.tsx')
  const ai = source('../src/client/ai-collab-pane.tsx')
  assert.ok(pane.includes('active={active === tab.id}'))
  assert.ok(pane.includes('hidden={active !== tab.id}'))
  assert.ok(object.includes('if (!active || !connection.live)'))
  assert.ok(sql.includes('if (active && connection.live && schema)'))
  assert.ok(ai.includes('if (active && connection.live && activeSchema)'))
})

test('AI hydration is single-flight and aborts its long poll', () => {
  const bus = source('../src/client/ai-query-bus.ts')
  assert.ok(bus.includes('hydrateRef.current?.key === hydrateKey'))
  assert.ok(bus.includes('currentHydrateKey.current !== key'))
  assert.ok(bus.includes("'execution-wait', { revision: seen }, controller.signal"))
  assert.ok(bus.includes('controller.abort()'))
})

test('trusted authorization is isolated from manual SQL and validated in the worker', () => {
  const worker = source('../src/host/connection-worker.mjs')
  assert.ok(worker.includes('function trustedAuthorization'))
  assert.ok(worker.includes("message.action === 'query' ? trustedAuthorization"))
  assert.ok(worker.includes("message.action === 'manual-query' ? 'manual' : 'query'"))
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getUiSession } from '../src/client/current-resolver.ts'

test('database client keeps current then prop and does not bridge the sidebar', () => {
  const source = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  assert.ok(source.includes('sessions.current || props.fallbackSessionId'))
  assert.equal(source.includes('betterSidebar'), false)
  assert.equal(source.includes('resolveSeatConversationId'), false)
  assert.equal(source.includes('hero.modeActions'), false)
  assert.ok(source.includes('conversation.input.left'))
})

test('getUiSession returns undefined when ctx access throws', () => {
  const ctx = {
    get uiSession() {
      throw new Error('not injected')
    },
  }
  assert.equal(getUiSession(ctx), undefined)
})

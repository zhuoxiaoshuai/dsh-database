import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequestScope } from '../src/client/workspace/parts/request-scope.ts'

test('connection generation invalidates every old request and leaves the next one usable', () => {
  const scope = createRequestScope('connection:g1')
  const old = scope.begin()
  assert.equal(scope.isCurrent(old), true)
  scope.invalidate('connection:g2')
  assert.equal(old.signal.aborted, true)
  assert.equal(scope.isCurrent(old), false)
  scope.finish(old)
  const fresh = scope.begin()
  assert.equal(scope.isCurrent(fresh), true)
  scope.cancel(fresh)
  assert.equal(scope.isCurrent(fresh), false)
  scope.dispose()
  assert.equal(scope.begin().signal.aborted, true)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { isWritableEnvironment, normalizeEnvironment, environmentLabel } from '../src/shared/connection-permission.ts'

test('normalizeEnvironment maps legacy values to sit/uat/pvt', () => {
  assert.equal(normalizeEnvironment('dev'), 'sit')
  assert.equal(normalizeEnvironment('test'), 'sit')
  assert.equal(normalizeEnvironment('staging'), 'uat')
  assert.equal(normalizeEnvironment('prod'), 'pvt')
  assert.equal(normalizeEnvironment('sit'), 'sit')
  assert.equal(normalizeEnvironment('uat'), 'uat')
  assert.equal(normalizeEnvironment('pvt'), 'pvt')
  assert.equal(normalizeEnvironment(''), 'uat')
})

test('isWritableEnvironment is true only for sit', () => {
  assert.equal(isWritableEnvironment('sit'), true)
  assert.equal(isWritableEnvironment('dev'), true)
  assert.equal(isWritableEnvironment('uat'), false)
  assert.equal(isWritableEnvironment('pvt'), false)
  assert.equal(isWritableEnvironment('prod'), false)
})

test('environment labels distinguish manual SQL writes from maintenance/AI limits', () => {
  assert.match(environmentLabel.sit, /可编辑/)
  assert.match(environmentLabel.uat, /人工 SQL 可写/)
  assert.match(environmentLabel.pvt, /人工 SQL 可写/)
})

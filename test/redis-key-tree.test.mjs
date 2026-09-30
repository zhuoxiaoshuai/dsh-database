import test from 'node:test'
import assert from 'node:assert/strict'
import { buildKeyTree } from '../src/client/redis/key-tree.ts'

test('accumulated Redis keys are deduped before colon grouping, and folders have no count', () => {
  const names = [...new Set(['solo', 'solo', 'a:b', 'a:b', 'a:c:d'])]
  const tree = buildKeyTree(names)
  assert.deepEqual(tree.leaves, ['solo'])
  assert.equal(tree.folders[0].label, 'a')
  assert.equal('count' in tree.folders[0], false)
  assert.deepEqual(tree.folders[0].children.map(child => child.label), ['b', 'c'])
  assert.equal(tree.folders[0].children[0].key, 'a:b')
  assert.equal(tree.folders[0].children[1].children[0].key, 'a:c:d')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { registerNacosAiTools } from '../src/host/data-sources/nacos/ai-tools.ts'

function fixture(connections = []) {
  const tools = new Map()
  const calls = []
  const service = {
    list: () => connections,
    restoreRemembered: async () => {},
    nacosRequest: async (_owner, id, generation, action) => {
      calls.push({ id, generation, action })
      return { id, generation, action }
    },
  }
  registerNacosAiTools({ tools: { register(tool) { tools.set(tool.name, tool) } } }, service, {}, id => id === 'owner')
  const execution = { agent: { session: { id: 'owner' } }, callId: 'c', rootCallId: 'r', signal: new AbortController().signal }
  return { tools, calls, execution }
}

test('nacos handles are optional and business fields stay required', () => {
  const { tools } = fixture()
  const namespaces = tools.get('nacos_namespaces').parameters
  assert.equal(namespaces.required, undefined)
  assert.match(namespaces.properties.connectionId.description, /唯一已登录/)
  assert.match(namespaces.properties.generation.description, /省略则用当前/)
  const config = tools.get('nacos_get_config').parameters
  assert.deepEqual(config.required, ['namespaceId', 'group', 'dataId'])
  assert.equal(config.required.includes('connectionId'), false)
  assert.ok(tools.get('nacos_publish_config').parameters.required.includes('previewToken'))
  assert.ok(tools.get('nacos_publish_config').parameters.required.includes('namespaceId'))
  assert.deepEqual(tools.get('nacos_publish_config').parameters.properties.type.enum,['yaml','json','properties','xml','html','text'])
  const remove = tools.get('nacos_delete_config').parameters.required
  assert.ok(remove.includes('expectedMd5'))
  assert.ok(remove.includes('previewToken'))
  assert.equal(remove.includes('connectionId'), false)
})

test('nacos tools bind the only live connection and return a Nacos list otherwise', async () => {
  const none = fixture()
  const missing = JSON.parse(await none.tools.get('nacos_namespaces').execute({}, none.execution))
  assert.equal(missing.ok, false)
  assert.match(missing.error, /Nacos/)
  assert.doesNotMatch(missing.error, /Kafka/)
  assert.match(missing.help, /nacos_status/)
  assert.deepEqual(missing.connections, [])
  assert.equal(none.calls.length, 0)

  const only = fixture([
    { id: 'n1', dialect: 'nacos', generation: 'g1', live: true, name: 'one' },
    { id: 'sql1', dialect: 'mysql', generation: 'gs', live: true, name: 'sql' },
  ])
  const listed = JSON.parse(await only.tools.get('nacos_status').execute({}, only.execution))
  assert.match(listed.help, /可省略/)
  assert.equal(listed.next[0].tool, 'nacos_namespaces')
  assert.equal(listed.connections.length, 1)
  const omitted = JSON.parse(await only.tools.get('nacos_namespaces').execute({}, only.execution))
  assert.deepEqual(omitted, { id: 'n1', generation: 'g1', action: 'nacos-namespaces' })
  assert.equal(only.calls.length, 1)

  const stale = JSON.parse(await only.tools.get('nacos_namespaces').execute({ connectionId: 'n1', generation: 'old' }, only.execution))
  assert.equal(stale.ok, false)
  assert.equal(stale.connections.find(item => item.connectionId === 'n1').generation, 'g1')
  assert.match(stale.help, /nacos_status/)
  assert.equal(only.calls.length, 1)

  const foreign = JSON.parse(await only.tools.get('nacos_namespaces').execute({ connectionId: 'sql1', generation: 'gs' }, only.execution))
  assert.equal(foreign.ok, false)
  assert.match(foreign.error, /Nacos/)
  assert.equal(foreign.connections.some(item => item.connectionId === 'sql1'), false)
  assert.equal(only.calls.length, 1)

  const many = fixture([
    { id: 'n1', dialect: 'nacos', generation: 'g1', live: true, name: 'one' },
    { id: 'n2', dialect: 'nacos', generation: 'g2', live: true, name: 'two' },
  ])
  const ambiguous = JSON.parse(await many.tools.get('nacos_namespaces').execute({}, many.execution))
  assert.equal(ambiguous.ok, false)
  assert.deepEqual(ambiguous.connections.map(item => item.connectionId), ['n1', 'n2'])
  assert.match(ambiguous.help, /nacos_status/)
  assert.equal(many.calls.length, 0)
})

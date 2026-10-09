import test from 'node:test'
import assert from 'node:assert/strict'
import { createClientSourceRegistry } from '../src/shared/data-sources/registry.ts'
import { createConnectionFormRegistry } from '../src/client/workspace/connection/connection-form-registry.ts'
import { createWorkspaceRegistry } from '../src/client/workspace/parts/workspace-registry.ts'
import { createExplorerRegistry } from './helpers/source-registries.ts'
import { createKnowledgeRegistry } from './helpers/source-registries.ts'
import { createKnowledgePolicyRegistry } from '../src/host/knowledge-policy-registry.ts'
import { createClientModuleRegistry } from '../src/client/data-sources/registry-core.ts'
import { createHostModuleRegistry } from '../src/host/data-sources/modules.ts'

test('registries validate isolated source contracts; full workflow uses source-module UI acceptance', async () => {
  const ids = ['mock-source']
  const client = createClientSourceRegistry([{
    id: 'mock-source', displayName: 'Mock', connection: {
      validateConnectionTarget: database => { if (!database) throw new Error('target required') },
      connectionExtras: () => ({}), connectionFingerprintSuffix: () => ['mock'],
    },
  }], ids)
  const form = createConnectionFormRegistry([{
    id: 'mock-source', createInput: () => ({ database: 'database' }), showCredentials: () => true, fields: input => input.database,
  }], ids)
  const explorer = createExplorerRegistry([{ id: 'mock-source', list: async () => ({ sourceId: 'mock-source', nodes: [{ ref: 'item:1', title: 'Item', kind: 'item', hasChildren: false }], complete: true }), read: async () => ({ value: 1 }) }], ids)
  const modules = createClientModuleRegistry([{
    id: 'mock-source', descriptor: { id: 'mock-source' }, connection: { id: 'mock-source' },
    workspace: { mode: 'standard', useBindings() { return {} } },
    history: { id: 'mock-source', renderText: record => record.text,
      resultEnvelope: (_record, payload) => ({ sourceId: 'mock-source', kind: 'document', status: 'succeeded', truncated: false, payload }),
      renderResult: envelope => envelope.payload.value },
  }], ids)
  const knowledge = createKnowledgeRegistry([{ id: 'mock-source', dispatch: (_store, connectionId, body) => ({ connectionId, text: body.text }) }], ids)
  const knowledgePolicy = createKnowledgePolicyRegistry([{ id: 'mock-source', analyze: text => ({ fingerprint: `mock:${text}`, operation: 'READ', risk: 'readonly', semantic: false }) }], ids)
  const workspace = createWorkspaceRegistry([{ id: 'mock-source', render: context => ({ title: context.title }) }], ids)

  client.get('mock-source').connection.validateConnectionTarget('database')
  assert.equal(form.get('mock-source').fields({ database: 'database' }), 'database')
  assert.throws(() => createConnectionFormRegistry([{ id: 'mock-source', target: input => input.database }], ids), /无效或重复/)
  const page = await explorer.get('mock-source').list({}, {})
  assert.equal((await explorer.get('mock-source').read({}, { ref: page.nodes[0].ref })).value, 1)
  const history = modules.get('mock-source').history
  const envelope = history.resultEnvelope({}, { value: 1 })
  assert.equal(history.renderResult(envelope), 1)
  assert.deepEqual(knowledge.get('mock-source').dispatch({}, 'connection-1', { text: 'READ item' }), { connectionId: 'connection-1', text: 'READ item' })
  assert.equal(knowledgePolicy.get('mock-source').analyze('READ item').fingerprint, 'mock:READ item')
  assert.deepEqual(workspace.get('mock-source').render({ title: '总览、查询、AI Query、知识库' }), { title: '总览、查询、AI Query、知识库' })
  for (const registry of [client, form, explorer, modules, knowledge, knowledgePolicy, workspace]) assert.throws(() => registry.get('unknown'), /不支持/)
})

test('combined modules reject incomplete capabilities and unknown IDs', () => {
  const clientModule = { id: 'mysql', descriptor: { id: 'mysql' }, connection: { id: 'mysql' }, workspace: { mode: 'standard', useBindings: () => ({}) },
    history: { id: 'mysql', renderText() {}, resultEnvelope() {}, renderResult() {} } }
  const client = createClientModuleRegistry([clientModule], ['mysql'])
  assert.equal(client.get('mysql'), clientModule)
  assert.throws(() => client.get('unknown'), /不支持/)
  assert.throws(() => createClientModuleRegistry([{ ...clientModule, workspace: undefined }], ['mysql']), /不完整/)
  assert.throws(() => createClientModuleRegistry([{ ...clientModule, history: undefined }], ['mysql']), /不完整/)
  assert.throws(() => createClientModuleRegistry([{ ...clientModule, workspace: { mode: 'legacy-sql', render: () => null } }], ['mysql']), /不完整/)
  assert.throws(() => createClientModuleRegistry([{ ...clientModule, workspace: { mode: 'standard', useBindings: undefined } }], ['mysql']), /不完整/)
  assert.throws(() => createClientModuleRegistry([clientModule, clientModule], ['mysql']), /重复/)
  const hostModule = { id: 'mysql', runtime: { id: 'mysql' }, connection: { validate() {}, fingerprint() {}, normalizeStoredSettings() {} },
    explorer: { list() {}, read() {} }, knowledge: { dispatch() {} }, ai: { key: 'sql', register() {} },
    execution: { mode: 'standard-text', prepareText() {}, normalizeContext() {}, authorize() {} } }
  const host = createHostModuleRegistry([hostModule], ['mysql'])
  assert.equal(host.get('mysql'), hostModule)
  assert.throws(() => host.get('unknown'), /不支持/)
  assert.throws(() => createHostModuleRegistry([{ ...hostModule, knowledge: undefined }], ['mysql']), /不完整/)
  assert.throws(() => createHostModuleRegistry([{ ...hostModule, ai: undefined }], ['mysql']), /不完整/)
  assert.throws(() => createHostModuleRegistry([{ ...hostModule, connection: { ...hostModule.connection, normalizeStoredSettings: undefined } }], ['mysql']), /不完整/)
  const standard = { ...hostModule, execution: { mode: 'standard-text', prepareText() {}, normalizeContext() {}, authorize() {} } }
  assert.equal(createHostModuleRegistry([standard], ['mysql']).get('mysql'), standard)
  for (const missing of ['prepareText', 'normalizeContext', 'authorize']) assert.throws(() => createHostModuleRegistry([{ ...standard, execution: { ...standard.execution, [missing]: undefined } }], ['mysql']), /不完整/)
  assert.throws(() => createHostModuleRegistry([{ ...standard, execution: { mode: 'legacy-adapter' } }], ['mysql']), /不完整/)
  assert.throws(() => createHostModuleRegistry([standard, standard], ['mysql']), /重复/)
})

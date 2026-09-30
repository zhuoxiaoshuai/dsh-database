// Test-only source. This module is registered only in an isolated acceptance bundle.
export const mockRuntime = { id: 'mock-source', workerEntry: 'connection-worker.mjs', actions: ['mock-read'], documentKind: 'command', textExecution: true, requiresPassword: false, usesCustomCa: () => false }
export const mockDescriptor = { id: 'mock-source', family: 'kafka', displayName: '模拟源', badge: 'TEST', showsSchemaTree: false }
export const mockPolicy = { id: 'mock-source', analyze(text) {
  if (!/^READ [a-z]+$/.test(text)) throw new Error('模拟源只允许 READ 对象。')
  return { fingerprint: text, operation: 'READ', risk: 'readonly', semantic: false }
} }
export const mockHostModule = {
  id: 'mock-source', family: 'kafka', runtime: mockRuntime,
  connection: { validate: raw => ({ dialect: 'mock-source', name: raw.name, environment: raw.environment, address: 'fixture', password: '' }), fingerprint: () => 'mock-fixture', normalizeStoredSettings: raw => ({ ...raw }) },
  execution: { mode: 'standard-text', normalizeContext(raw) {
    if (raw && Object.keys(raw).length) throw new Error('模拟源不接受额外目标。')
    return {}
  }, prepareText(text) {
    mockPolicy.analyze(text)
    return { action: 'mock-read', text, input: { text }, operation: 'mock_read', title: '读取模拟对象', summarize: () => '读取完成。' }
  }, authorize(prepared, actor, binding) {
    if (!['user', 'ai'].includes(actor) || !binding.generation || binding.dialect !== 'mock-source') throw new Error('模拟源授权失败。')
    mockPolicy.analyze(prepared.text)
  } },
  explorer: { id: 'mock-source', readonlyActions: ['mock-read'], list: async () => ({ sourceId: 'mock-source', nodes: [{ ref: 'item', title: '对象 item', kind: 'item', hasChildren: false }], complete: true }), read: async transport => transport.source('mock-read', { text: 'READ item' }) },
  knowledge: { id: 'mock-source', dispatch(store, connectionId, body) {
    if (body.action === 'knowledge-search') return { items: store.searchKnowledge('mock-source', connectionId, body.query) }
    if (body.action === 'knowledge-publish') return store.publishKnowledge({ ...body, sourceId: 'mock-source', connectionId })
    if (body.action === 'knowledge-archive') return store.archiveKnowledge('mock-source', body.id, connectionId)
    throw new Error('模拟源经验操作无效。')
  } },
  ai: { key: 'mock-source', register(ctx, service, _executions, validOwner) {
    ctx.tools.register({ name: 'mock_read', async execute(args, call) {
      const owner = call.agent.session.id
      if (!validOwner(owner)) throw new Error('对话无效。')
      const previous = service.getExecutionDocument(owner, args.id, args.generation)
      const document = service.updateExecutionDocument(owner, args.id, args.text, 'ai', previous.revision, args.generation)
      return service.executeText(owner, args.id, args.generation, document.text, undefined, 'ai', call.callId, document.revision, undefined, document.context)
    } })
  } },
}

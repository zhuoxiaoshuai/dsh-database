import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConnectionService } from './connection-service.ts'
import type { ExecutionStore } from './execution-store.ts'
import type { CatalogRequest } from '../shared/workbench.ts'
import { parseBrowserQueryInitiator } from './sql-browser-request.ts'
import { httpStatusForConnectionError, inferConnectionErrorCode } from '../shared/connection-errors.ts'
import { CONNECTION_API_ACTIONS, type ConnectionApiAction, type ServiceRequestAction } from '../shared/database-actions.ts'

const CONNECTION_API_ACTION_SET = new Set<string>(CONNECTION_API_ACTIONS)

function isConnectionApiAction(value: unknown): value is ConnectionApiAction {
  return typeof value === 'string' && CONNECTION_API_ACTION_SET.has(value)
}

async function withResponseAbort<T>(res: ServerResponse, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const cancel = () => { if (!res.writableEnded) controller.abort() }
  res.once('close', cancel)
  try { return await work(controller.signal) }
  finally { res.off('close', cancel) }
}

export async function connectionApi(service: ConnectionService, executions: ExecutionStore, owner: string, req: IncomingMessage, res: ServerResponse) {
  const send = (status: number, body: unknown) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)) } }
  const storage = () => ({ executionHistory: { degraded: executions.storageDegraded, retrying: executions.persistenceRetrying }, workspace: { degraded: service.storageDegraded } })
    if (req.method === 'GET') {
    try {
      send(200, { ...service.snapshot(owner), storage: storage() })
    } catch (error) {
      const message = error instanceof Error ? error.message : '当前对话已失效。'
      send(message.includes('已失效') ? 404 : 400, { error: message })
    }
    return
  }
  if (req.method !== 'POST') { send(405, { error: '不支持此操作。' }); return }
  if (!req.headers['content-type']?.startsWith('application/json')) { send(415, { error: '需要 JSON 请求。' }); return }
  let body: Record<string, unknown> | undefined
  try {
    let size = 0; const chunks: Buffer[] = []
    for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > 524288) { send(413, { error: '连接请求过大。' }); return }; chunks.push(Buffer.from(chunk)) }
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { send(400, { error: '请求格式不正确。' }); return }
    if (!body || typeof body !== 'object') { send(400, { error: '请求格式不正确。' }); return }
    const requestBody = body
    const unsupported = () => send(400, { error: '不支持此操作。' })
    type ActionHandler = (input: Record<string, unknown>) => Promise<void>
    const requireId = (input: Record<string, unknown>): string | undefined => {
      if (typeof input.id === 'string') return input.id
      unsupported()
      return undefined
    }
    const serviceRequest = (action: ServiceRequestAction): ActionHandler => async input => {
      const id = requireId(input)
      if (id === undefined) return
      send(200, await withResponseAbort(res, signal =>
        service.request(owner, id, input.generation, action, input.input as CatalogRequest, signal)))
    }
    const openConnection = (test: boolean): ActionHandler => async input => {
      const result = await service.open(owner, input.input, test, test && typeof input.id === 'string' ? input.id : undefined)
      if (res.destroyed && 'id' in result) await service.remove(owner, result.id).catch(() => {})
      send(200, result)
    }
    const handlers = {
      'execution-list': async () => { send(200, { revision: executions.revision(owner), items: executions.list(owner) }) },
      'execution-get': async input => {
        if (typeof input.executionId !== 'string') { unsupported(); return }
        const record = executions.get(owner, input.executionId, true)
        if (!record) { send(404, { error: '执行记录不存在。' }); return }
        send(200, record)
      },
      'execution-cancel': async input => {
        if (typeof input.executionId !== 'string') { unsupported(); return }
        const current = executions.get(owner, input.executionId)
        if (!current) { send(404, { error: '执行记录不存在。' }); return }
        send(200, executions.cancel(owner, input.executionId, executions.dispatched(input.executionId)))
      },
      'execution-wait': async input => {
        const revision = typeof input.revision === 'number' ? input.revision : 0
        send(200, { ...await withResponseAbort(res, signal => executions.wait(owner, revision, 10000, signal)), storage: storage() })
      },
      'execution-persistence-retry': async input => {
        if (Object.keys(input).some(key => key !== 'action')) { unsupported(); return }
        const outcome = await executions.retryPersistence()
        send(outcome.saved ? 200 : 503, { ...outcome, storage: storage(), ...(outcome.saved ? {} : { error: '执行历史仍未可靠落盘，请检查存储后重试。' }) })
      },
      'execution-latest': async input => {
        const id = requireId(input)
        if (id === undefined) return
        send(200, { execution: executions.latestDisplay(owner, id) || null })
      },
      catalog: serviceRequest('catalog'),
      query: serviceRequest('query'),
      'manual-query': serviceRequest('manual-query'),
      browse: serviceRequest('browse'),
      maintenance: serviceRequest('maintenance'),
      'redis-command': async input => { const id = requireId(input); if (id !== undefined) send(200, await withResponseAbort(res, signal => service.redisRequest(owner, id, input.generation, 'redis-command', input.input, signal))) },
      'redis-scan': async input => { const id = requireId(input); if (id !== undefined) send(200, await withResponseAbort(res, signal => service.redisRequest(owner, id, input.generation, 'redis-scan', input.input, signal))) },
      'redis-key-suggest': async input => { const id = requireId(input); if (id !== undefined) send(200, await withResponseAbort(res, signal => service.redisRequest(owner, id, input.generation, 'redis-key-suggest', input.input, signal))) },
      'redis-key': async input => { const id = requireId(input); if (id !== undefined) send(200, await withResponseAbort(res, signal => service.redisRequest(owner, id, input.generation, 'redis-key', input.input, signal))) },
      'source-execute': async input => {
        const id = requireId(input)
        if (id === undefined) return
        if (!input.input || typeof input.input !== 'object' || typeof (input.input as { text?: unknown }).text !== 'string') { unsupported(); return }
        send(200, await withResponseAbort(res, signal => service.executeText(owner, id, input.generation, (input.input as { text: string }).text, signal, 'user', undefined, undefined, undefined, (input.input as { context?: unknown }).context)))
      },
      'explorer-list': async input => {
        const id = requireId(input)
        if (id === undefined) return
        if (!input.input || typeof input.input !== 'object' || Array.isArray(input.input)) { unsupported(); return }
        send(200, await withResponseAbort(res, signal => service.explorerList(owner, id, input.generation, input.input as import('../shared/explorer.ts').ExplorerListInput, signal)))
      },
      'explorer-read': async input => {
        const id = requireId(input)
        if (id === undefined) return
        if (!input.input || typeof input.input !== 'object' || Array.isArray(input.input) || typeof (input.input as { ref?: unknown }).ref !== 'string') { unsupported(); return }
        send(200, await withResponseAbort(res, signal => service.explorerRead(owner, id, input.generation, input.input as import('../shared/explorer.ts').ExplorerReadInput, signal)))
      },
      'shared-query-get': async input => {
        const id = requireId(input)
        if (id !== undefined) send(200, { sharedQuery: service.getSharedQuery(owner, id) })
      },
      'execution-document-get': async input => {
        const id = requireId(input)
        if (id !== undefined) send(200, { document: service.getExecutionDocument(owner, id, input.generation) })
      },
      'execution-document-update': async input => {
        const id = requireId(input)
        if (id === undefined) return
        const document = service.updateExecutionDocumentFromBrowser(owner, id, input)
        send(200, { document, ...(input.source === 'format' ? { sharedQuery: service.getSharedQuery(owner, id) } : {}) })
      },
      'execution-document-context': async input => {
        const id = requireId(input)
        if (id === undefined) return
        service.assertBrowserDocumentRequest(owner, id, input.generation, input.revision)
        const context = input.context ?? (typeof input.database === 'string' ? { database: input.database } : undefined)
        if (!context || typeof context !== 'object' || Array.isArray(context)) { unsupported(); return }
        send(200, { document: service.patchExecutionDocumentContext(owner, id, context as Record<string, unknown>, input.generation, typeof input.revision === 'number' ? input.revision : undefined) })
      },
      'execution-document-control': async input => {
        const id = requireId(input)
        if (id === undefined) return
        service.assertBrowserDocumentRequest(owner, id, input.generation, input.revision)
        send(200, { document: service.controlExecutionDocument(owner, id, input.controller === 'ai' ? 'ai' : 'user', typeof input.reason === 'string' ? input.reason : 'user-takeover', input.generation, input.revision as number) })
      },
      'execution-document-run': async input => {
        const id = requireId(input)
        if (id === undefined) return
        if (typeof input.revision !== 'number') { unsupported(); return }
        send(200, await withResponseAbort(res, signal => service.runExecutionDocument(owner, id, input.generation, input.revision as number, signal, typeof input.text === 'string' ? input.text : undefined)))
      },
      'shared-query-update': async input => {
        const id = requireId(input)
        if (id === undefined) return
        send(200, { sharedQuery: service.updateSharedQueryFromBrowser(owner, id, input) })
      },
      'shared-query-control': async input => {
        const id = requireId(input)
        if (id === undefined) return
        service.assertBrowserDocumentRequest(owner, id, input.generation, input.revision)
        service.controlExecutionDocument(owner, id, input.controller === 'ai' ? 'ai' : 'user', typeof input.reason === 'string' ? input.reason : 'user-takeover', input.generation, input.revision as number)
        send(200, { sharedQuery: service.getSharedQuery(owner, id) })
      },
      'shared-query-run': async input => {
        const id = requireId(input)
        if (id === undefined) return
        service.assertBrowserDocumentRequest(owner, id, input.generation, input.revision)
        const request = {
          connectionId: id,
          generation: input.generation,
          schema: String(input.schema || ''),
          sql: String(input.sql || ''),
          revision: typeof input.revision === 'number' ? input.revision : undefined,
          initiator: parseBrowserQueryInitiator(input.initiator),
          purpose: input.purpose === 'verify' || input.purpose === 'result' ? input.purpose : undefined,
        }
        send(200, await withResponseAbort(res, signal => service.runSharedQuery(owner, request, signal)))
      },
      'shared-query-explain': async input => {
        const id = requireId(input)
        if (id === undefined) return
        if (typeof input.revision !== 'number') { send(400, { error: '缺少文档修订，请刷新。' }); return }
        const explainInput = { schema: String(input.schema || ''), sql: String(input.sql || ''), revision: input.revision, initiator: 'user' as const }
        send(200, await withResponseAbort(res, signal => service.explainPlan(owner, id, input.generation, explainInput, signal)))
      },
      activate: async input => {
        service.activate(owner, typeof input.id === 'string' ? input.id : undefined)
        send(200, { saved: true })
      },
      workbench: async input => {
        const id = requireId(input)
        if (id !== undefined) send(200, { workbench: service.saveWorkbench(owner, id, input.workbench) })
      },
      disconnect: async input => {
        const id = requireId(input)
        if (id === undefined) return
        await service.disconnect(owner, id)
        send(200, { disconnected: true })
      },
      remove: async input => {
        const id = requireId(input)
        if (id === undefined) return
        await service.remove(owner, id)
        send(200, { removed: true })
      },
      update: async input => {
        const id = requireId(input)
        if (id !== undefined) send(200, await service.update(owner, id, input.input))
      },
      duplicate: async input => {
        const id = requireId(input)
        if (id === undefined) return
        send(200, await service.duplicate(owner, id))
      },
      test: openConnection(true),
      connect: openConnection(false),
    } satisfies Record<ConnectionApiAction, ActionHandler>

    if (typeof requestBody.action === 'string' && requestBody.action.startsWith('knowledge-')) {
      send(200, await service.handleKnowledge(owner, requestBody))
      return
    }
    if (typeof requestBody.action === 'string' && requestBody.action.startsWith('template-')) {
      send(200, await service.handleTemplate(owner, requestBody))
      return
    }
    if (!isConnectionApiAction(requestBody.action)) { unsupported(); return }
    await handlers[requestBody.action](requestBody)
  } catch (error) {
    const message = error instanceof Error ? error.message : '连接请求失败。'
    const code = error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : inferConnectionErrorCode(message)
    const outcome = error as { effect?: string; phase?: string; category?: string; databaseCode?: string; steps?: unknown; batch?: unknown; executionId?: string; executionStatus?: string;
      kind?: 'query' | 'write' | 'explain'; identity?: unknown; connectionId?: string; generation?: string; schema?: string; context?: Record<string, string>; documentText?: string; executedSql?: string; queryRevision?: number; initiator?: 'user' | 'ai' }
    send(httpStatusForConnectionError(code), { error: message, ...(code ? { code } : {}),
      ...(outcome.effect ? { effect: outcome.effect } : {}), ...(outcome.phase ? { phase: outcome.phase } : {}),
      ...(outcome.category ? { category: outcome.category } : {}), ...(outcome.databaseCode ? { databaseCode: outcome.databaseCode } : {}),
      ...(outcome.executionId ? { executionId: outcome.executionId, status: outcome.executionStatus, connectionId: outcome.connectionId,
        generation: outcome.generation, schema: outcome.schema, context: outcome.context, documentText: outcome.documentText,
        executedSql: outcome.executedSql, queryRevision: outcome.queryRevision, initiator: outcome.initiator,
        ...(outcome.identity ? { identity: outcome.identity } : {}), ...(outcome.kind ? { kind: outcome.kind } : {}) } : {}), ...(outcome.steps ? { steps: outcome.steps, batch: outcome.batch } : {}) })
  }
  finally { if (body?.input && typeof body.input === 'object') { (body.input as Record<string, unknown>).password = ''; (body.input as Record<string, unknown>).caPem = '' } }
}

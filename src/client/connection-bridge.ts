import { validExecutionReply, validSteps } from './execution-reply.ts'
import { executeKnowledgeRequest } from './knowledge-sql-request.ts'
import type { CatalogResult, Connection, ConnectionTest, ConnectionWorkbench, DatabaseWorkspaceSnapshot, MaintenanceResult, Result, WorkspaceBridge } from '../shared/workbench.ts'
import { ConnectionRequestError, inferConnectionErrorCode, transportRequestError } from '../shared/connection-errors.ts'
import { DEFAULT_QUERY_PAGE_SIZE } from '../shared/limits.ts'
import type { RedisResponse } from '../shared/redis-result.ts'

export function connectionBridge(conversationId: string, base: WorkspaceBridge, preview = false): WorkspaceBridge {
  const endpoint = `${preview ? '/api/database/connections' : '/plugins/database/connections'}?conversationId=${encodeURIComponent(conversationId)}`
  const request = async (body?: unknown, signal?: AbortSignal) => {
    const input = body && typeof body === 'object' ? body as { id?: string; action?: string; input?: { kind?: string; operation?:string } } : undefined
    const connectionId = typeof input?.id === 'string' ? input.id : undefined
    const nacosWrite=input?.action==='nacos-request' && input.input?.operation==='nacos-write'
    const executing = nacosWrite || ['query', 'manual-query', 'source-execute', 'execution-document-run', 'shared-query-run', 'shared-query-explain', 'explain'].includes(input?.action || '')
      || input?.action === 'maintenance' && input.input?.kind === 'execute'
    if (body && new TextEncoder().encode(JSON.stringify(body)).byteLength > 524288) throw new Error('请求超过 512 KiB，不能提交。')
    if (signal?.aborted) throw transportRequestError('未派发，请求已取消。', connectionId, 'before-fetch')
    let response: Response
    try { response = await fetch(endpoint, { signal, method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }) }
    catch { throw transportRequestError('未收到可信回执，请求结果未知；写入须先核验，不能重试原写入。', connectionId, 'fetch') }
    let parsed: unknown
    try { parsed = await response.json() } catch { throw transportRequestError('响应体不完整或不是有效 JSON，请求结果未知。', connectionId, 'response') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw transportRequestError('响应结构无效，请求结果未知。', connectionId, 'response')
    const value = parsed as { error?: string; code?: string; effect?: string; phase?: string; category?: string; databaseCode?: string; executionId?: string; status?: string; steps?: unknown; batch?: unknown;
      generation?: string; schema?: string; context?: Record<string, string>; documentText?: string; executedSql?: string; queryRevision?: number; initiator?: 'user' | 'ai' }
    if (!response.ok) {
      const trustedReceipt = typeof value.error === 'string' && ['none', 'unknown', 'committed'].includes(value.effect || '')
        && ['check', 'execute', 'commit', 'receipt'].includes(value.phase || '') && validSteps(value.steps)
      const reported = typeof value.error === 'string' ? value.error.trim() : ''
      if (executing && !trustedReceipt) {
        if (!reported) throw transportRequestError('HTTP 错误缺少可信执行回执，请求结果未知。', connectionId, 'response')
        const code = value.code || inferConnectionErrorCode(reported)
        throw Object.assign(new ConnectionRequestError(reported, code, connectionId), {
          trustedReceipt: false, requestPhase: 'response', effect: 'unknown', phase: 'receipt', category: value.category, databaseCode: value.databaseCode,
          executionId: value.executionId, executionStatus: value.status, generation: value.generation, schema: value.schema, context: value.context,
          documentText: value.documentText, executedSql: value.executedSql, queryRevision: value.queryRevision, initiator: value.initiator,
        })
      }
      const message = reported
        || (response.status === 401 || response.status === 403 ? '需要通过 DSH 认证访问，请刷新工作台。' : '')
        || (response.status === 404 ? '当前对话已失效，请刷新工作台。' : '')
        || `连接服务不可用（${response.status}），请刷新工作台。`
      const code = value.code || inferConnectionErrorCode(message)
      throw Object.assign(new ConnectionRequestError(message, code, connectionId), { ...value, trustedReceipt, requestPhase: 'response', effect: value.effect, phase: value.phase, category: value.category, databaseCode: value.databaseCode, executionId: value.executionId, executionStatus: value.status, steps: value.steps, batch: value.batch,
        generation: value.generation, schema: value.schema, context: value.context, documentText: value.documentText, executedSql: value.executedSql, queryRevision: value.queryRevision, initiator: value.initiator })
    }
    const nacosReceipt=nacosWrite && (value as any).saved===true && (value as any).executionStatus==='succeeded'
    const maintenanceReceipt = input?.action === 'maintenance' && ['success', 'failed', 'unknown', 'cancelled'].includes(String(value.status))
    if (executing && !nacosReceipt && !maintenanceReceipt && !validExecutionReply(value, input?.action)) throw transportRequestError('成功响应缺少有效执行回执，请求结果未知。', connectionId, 'response')
    return value
  }
  const sourceRequest = (connection: Connection, action: string, input: object, signal?: AbortSignal) =>
    request({ action, id: connection.id, generation: connection.generation, input }, signal)
  return { ...base, conversationId,
    sourceRequest,
    executeKnowledge: (connection, sql, options) => connection.live
      ? executeKnowledgeRequest(endpoint, request, connection, sql, options)
      : (base.executeManual || base.execute)(connection, sql, options.stopSignal),
    executeText: (connection, text, context = {}, signal) => sourceRequest(connection, 'source-execute', { text, context }, signal),
    explorer: (connection, action, input, signal) => sourceRequest(connection, action === 'list' ? 'explorer-list' : 'explorer-read', input, signal) as Promise<any>,
    catalog: (connection, input, signal) => sourceRequest(connection, 'catalog', input, signal) as Promise<CatalogResult>,
    browse: (connection, input, signal) => sourceRequest(connection, 'browse', input, signal) as Promise<Result & { generatedSql: string; warning: string }>,
    maintenance: (connection, input) => sourceRequest(connection, 'maintenance', input) as Promise<MaintenanceResult>,
    redis: (connection, action, input, signal) => sourceRequest(connection, action, input, signal) as Promise<RedisResponse>,
    tables: connection => connection.live ? [] : base.tables(connection),
    execute: (connection, sql, signal) => connection.live ? sourceRequest(connection, 'query', { sql, schema: connection.database, limit: DEFAULT_QUERY_PAGE_SIZE }, signal) as Promise<Result> : base.execute(connection, sql, signal),
    executeManual: (connection, sql, signal) => connection.live
      ? sourceRequest(connection, 'manual-query', { sql, schema: connection.database, limit: DEFAULT_QUERY_PAGE_SIZE }, signal) as Promise<Result>
      : (base.executeManual || base.execute)(connection, sql, signal),
    testConnection: (input, id, signal) => request({ action: 'test', input, ...(id ? { id } : {}) }, signal) as Promise<ConnectionTest>,
    startConnection: async (input, operationId, id) => {
      try {
        const reply = await request({ action: 'connection-start', input, operationId, ...(id ? { id } : {}) }) as import('../shared/connection-lifecycle.ts').ConnectionStart
        if (typeof reply.connectionId !== 'string' || !reply.connectionId || reply.operationId !== operationId) throw transportRequestError('缺少可信的连接接受回执，请核对连接状态。', id, 'response')
        return reply
      }
      catch (error) {
        if ((error as { requestPhase?: string }).requestPhase !== 'fetch' && (error as { effect?: string }).effect !== 'unknown') throw error
        // A lost acceptance response must not create a second attempt/profile.
        try {
          const snapshot = await request() as DatabaseWorkspaceSnapshot
          const accepted = snapshot.connections.find(row => row.lifecycle?.operationId === operationId)
          if (accepted) return { connectionId: accepted.id, operationId }
        } catch { /* Keep the nonce for reconciliation after an uncertain acceptance. */ }
        throw Object.assign(error as Error, { acceptanceUnknown: true })
      }
    },
    cancelConnection: async (id, operationId) => { await request({ action: 'connection-cancel', id, operationId }) },
    connect: input => request({ action: 'connect', input }) as Promise<Connection>,
    updateConnection: (id, input) => request({ action: 'update', id, input }) as Promise<Connection>,
    duplicateConnection: id => request({ action: 'duplicate', id }) as Promise<Connection>,
    listWorkspace: async () => await request() as DatabaseWorkspaceSnapshot,
    listConnections: async () => ((await request()) as DatabaseWorkspaceSnapshot).connections,
    disconnectConnection: async id => { await request({ action: 'disconnect', id }) },
    removeConnection: async id => { await request({ action: 'remove', id }) },
    saveWorkbench: async (id, workbench) => ((await request({ action: 'workbench', id, workbench })) as { workbench: ConnectionWorkbench }).workbench,
    activate: async id => { await request({ action: 'activate', ...(id ? { id } : {}) }) },
    executions: (action, body, signal) => request({ action, ...body }, signal),
    templates: (action, body, signal) => request({ action, ...body }, signal),
  }
}

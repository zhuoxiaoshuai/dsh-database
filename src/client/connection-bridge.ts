import type { CatalogResult, Connection, ConnectionTest, ConnectionWorkbench, DatabaseWorkspaceSnapshot, MaintenanceResult, Result, WorkspaceBridge } from '../shared/workbench.ts'
import { ConnectionRequestError, inferConnectionErrorCode, transportRequestError } from '../shared/connection-errors.ts'
import { DEFAULT_QUERY_PAGE_SIZE } from '../shared/limits.ts'
import type { RedisResponse } from '../shared/redis-result.ts'

export function connectionBridge(conversationId: string, base: WorkspaceBridge, preview = false): WorkspaceBridge {
  const endpoint = `${preview ? '/api/database/connections' : '/plugins/database/connections'}?conversationId=${encodeURIComponent(conversationId)}`
  const request = async (body?: unknown, signal?: AbortSignal) => {
    const input = body && typeof body === 'object' ? body as { id?: string; action?: string; input?: { kind?: string } } : undefined
    const connectionId = typeof input?.id === 'string' ? input.id : undefined
    const executing = ['query', 'manual-query', 'source-execute', 'execution-document-run', 'shared-query-run', 'shared-query-explain', 'explain'].includes(input?.action || '')
      || input?.action === 'maintenance' && input.input?.kind === 'execute'
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
      if (executing && !trustedReceipt) throw transportRequestError('HTTP 错误缺少可信执行回执，请求结果未知。', connectionId, 'response')
      const message = value.error
        || (response.status === 401 || response.status === 403 ? '需要通过 DSH 认证访问，请刷新工作台。' : '')
        || (response.status === 404 ? '当前对话已失效，请刷新工作台。' : '')
        || `连接服务不可用（${response.status}），请刷新工作台。`
      const code = value.code || inferConnectionErrorCode(message)
      throw Object.assign(new ConnectionRequestError(message, code, connectionId), { ...value, trustedReceipt, requestPhase: 'response', effect: value.effect, phase: value.phase, category: value.category, databaseCode: value.databaseCode, executionId: value.executionId, executionStatus: value.status, steps: value.steps, batch: value.batch,
        generation: value.generation, schema: value.schema, context: value.context, documentText: value.documentText, executedSql: value.executedSql, queryRevision: value.queryRevision, initiator: value.initiator })
    }
    const maintenanceReceipt = input?.action === 'maintenance' && ['success', 'failed', 'unknown', 'cancelled'].includes(String(value.status))
    if (executing && !maintenanceReceipt && !validExecutionReply(value, input?.action)) throw transportRequestError('成功响应缺少有效执行回执，请求结果未知。', connectionId, 'response')
    return value
  }
  const sourceRequest = (connection: Connection, action: string, input: object, signal?: AbortSignal) =>
    request({ action, id: connection.id, generation: connection.generation, input }, signal)
  return { ...base, conversationId,
    sourceRequest,
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
    testConnection: (input, id) => request({ action: 'test', input, ...(id ? { id } : {}) }) as Promise<ConnectionTest>,
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

function validExecutionReply(value: object, action?: string): boolean {
  const reply = value as Record<string, unknown>
  const sql = Array.isArray(reply.columns) && reply.columns.every(item => typeof item === 'string')
    && Array.isArray(reply.rows) && reply.rows.every(row => Array.isArray(row))
    && typeof reply.truncated === 'boolean' && typeof reply.elapsedMs === 'number'
  const payload = !!reply.result && typeof reply.result === 'object' && !Array.isArray(reply.result)
    || action === 'source-execute' && typeof reply.kind === 'string'
  return validSteps(reply.steps) && (sql || payload && typeof reply.executionId === 'string' && ['succeeded', 'failed', 'unknown', 'cancelled'].includes(String(reply.executionStatus ?? reply.status)))
}

function validSteps(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  const indexes = new Set<number>()
  return value.every(step => {
    if (!step || typeof step !== 'object' || !Number.isSafeInteger(step.index) || step.index < 0 || indexes.has(step.index)
      || typeof step.sql !== 'string' || !['succeeded', 'failed', 'unknown', 'not-run'].includes(step.status)
      || step.affectedRows !== undefined && (typeof step.affectedRows !== 'number' || !Number.isFinite(step.affectedRows))) return false
    indexes.add(step.index); return true
  })
}

import type { CatalogResult, Connection, ConnectionTest, ConnectionWorkbench, DatabaseWorkspaceSnapshot, MaintenanceResult, Result, WorkspaceBridge } from '../shared/workbench.ts'
import { ConnectionRequestError, inferConnectionErrorCode } from '../shared/connection-errors.ts'
import { DEFAULT_QUERY_PAGE_SIZE } from '../shared/limits.ts'
import type { RedisResponse } from '../shared/redis-result.ts'

export function connectionBridge(conversationId: string, base: WorkspaceBridge, preview = false): WorkspaceBridge {
  const endpoint = `${preview ? '/api/database/connections' : '/plugins/database/connections'}?conversationId=${encodeURIComponent(conversationId)}`
  const request = async (body?: unknown, signal?: AbortSignal) => {
    const response = await fetch(endpoint, { signal, method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
    const value = await response.json().catch(() => ({})) as { error?: string; code?: string }
    if (!response.ok) {
      const connectionId = body && typeof body === 'object' && 'id' in body && typeof (body as { id?: unknown }).id === 'string' ? (body as { id: string }).id : undefined
      const message = value.error
        || (response.status === 401 || response.status === 403 ? '需要通过 DSH 认证访问，请刷新工作台。' : '')
        || (response.status === 404 ? '当前对话已失效，请刷新工作台。' : '')
        || `连接服务不可用（${response.status}），请刷新工作台。`
      const code = value.code || inferConnectionErrorCode(message)
      throw new ConnectionRequestError(message, code, connectionId)
    }
    return value
  }
  const sourceRequest = (connection: Connection, action: string, input: object, signal?: AbortSignal) =>
    request({ action, id: connection.id, generation: connection.generation, input }, signal)
  return { ...base,
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

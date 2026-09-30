import type { Result, SharedQuery } from './workbench.ts'
import type { DisplayResult, WorkbenchEvent } from './execution.ts'
import { unwrapExplainSql } from './sql-text.ts'

export function sqlBelongsToEditor(editorSql: string, executedSql?: string): boolean {
  if (!executedSql) return true
  if (editorSql === executedSql) return true
  const editor = unwrapExplainSql(editorSql)
  const executed = unwrapExplainSql(executedSql)
  return editor === executed || editor === executedSql || editorSql === executed
}

export function displayKindOf(event: Pick<WorkbenchEvent, 'kind' | 'executedSql' | 'sql'>): DisplayResult['kind'] {
  if (event.kind === 'explain' || event.kind === 'write' || event.kind === 'query') return event.kind
  const sql = event.executedSql || event.sql || ''
  if (/^explain\b/i.test(sql.trim())) return 'explain'
  return 'query'
}

export function applyQueryChanged(
  local: SharedQuery,
  event: WorkbenchEvent,
  opts: { connectionId: string; localEditing?: boolean },
): SharedQuery | undefined {
  if (event.type !== 'QUERY_CHANGED' && event.type !== 'CONTROL_CHANGED') return
  if (event.connectionId !== opts.connectionId) return
  const remoteRevision = event.queryRevision
  if (remoteRevision == null || remoteRevision < local.revision) return
  if (
    remoteRevision === local.revision
    && (event.sql === undefined || event.sql === local.sql)
    && (event.controller === undefined || event.controller === local.controller)
    && (event.schema === undefined || event.schema === local.schema)
  ) return
  if (opts.localEditing && local.controller === 'user') return
  return {
    ...local,
    sql: event.sql !== undefined ? event.sql : local.sql,
    schema: event.schema !== undefined ? event.schema : local.schema,
    controller: event.controller || local.controller,
    revision: remoteRevision,
  }
}

export function hydrateSharedQuery(
  local: SharedQuery,
  remote: SharedQuery,
  opts: { connectionId: string; localEditing?: boolean },
): SharedQuery {
  return applyQueryChanged(local, {
    type: 'QUERY_CHANGED',
    connectionId: opts.connectionId,
    queryRevision: remote.revision,
    sql: remote.sql,
    schema: remote.schema,
    controller: remote.controller,
  }, opts) || local
}

export function displayMatchingEditor(current: DisplayResult | undefined, editorSql: string): DisplayResult | undefined {
  if (!current) return
  if (sqlBelongsToEditor(editorSql, current.executedSql)) return current
  return undefined
}

function gridRicher(current: Result, incoming: Result): boolean {
  return current.columns.length > incoming.columns.length || current.rows.length > incoming.rows.length
}

/** Live grid keeps the execution receipt. A clipped preview of the same run must not replace it. */
export function preferLiveGrid(current: DisplayResult | undefined, incoming: DisplayResult): DisplayResult {
  if (!current || current.executionId !== incoming.executionId) return incoming
  if (!gridRicher(current.result, incoming.result)) return incoming
  return { ...incoming, result: current.result }
}

export function keepHydratedDisplay(current: DisplayResult | undefined, next: DisplayResult | undefined, editorSql: string): DisplayResult | undefined {
  if (next) return preferLiveGrid(current, next)
  return displayMatchingEditor(current, editorSql)
}

export function applyExecutionResult(
  current: DisplayResult | undefined,
  event: WorkbenchEvent,
  opts: { connectionId: string; controller: SharedQuery['controller']; sql: string; queryRevision: number },
): DisplayResult | undefined {
  if (event.type !== 'EXECUTION_FINISHED' && event.type !== 'EXECUTION_FAILED') return current
  if (event.connectionId !== opts.connectionId || !event.executionId) return current
  if (event.initiator === 'ai' && opts.controller === 'user') return displayMatchingEditor(current, opts.sql)
  if (event.executedSql != null && !sqlBelongsToEditor(opts.sql, event.executedSql)) return displayMatchingEditor(current, opts.sql)
  const kind = displayKindOf(event)
  const failed = event.type === 'EXECUTION_FAILED'
  const message = event.message || (event.result as Result | undefined)?.message || (failed ? '执行失败' : undefined)
  const result = event.result || (failed
    ? { columns: [], rows: [], truncated: false, elapsedMs: 0, ...(message ? { message } : {}) }
    : undefined)
  if (!result) return current
  return preferLiveGrid(current, {
    connectionId: event.connectionId,
    executionId: event.executionId,
    queryRevision: event.queryRevision ?? opts.queryRevision,
    executedSql: event.executedSql || opts.sql,
    result: { ...result, ...(message ? { message } : {}) } as Result,
    kind,
  })
}

export function displayFromLatest(
  connectionId: string,
  query: SharedQuery,
  latest?: { executionId?: string; connectionId?: string; queryRevision?: number; executedSql?: string; sql?: string; type?: string; result?: Result; generation?: string; message?: string } | null,
  generation?: string,
): DisplayResult | undefined {
  if (!latest?.executionId) return
  if (latest.connectionId && latest.connectionId !== connectionId) return
  if (generation && latest.generation && latest.generation !== generation) return
  const executedSql = latest.executedSql || latest.sql || ''
  if (executedSql && !sqlBelongsToEditor(query.sql, executedSql)) return
  if (latest.type && latest.type !== 'query' && latest.type !== 'write' && latest.type !== 'explain') return
  if (!latest.result) return
  return {
    connectionId,
    executionId: latest.executionId,
    queryRevision: latest.queryRevision ?? query.revision,
    executedSql: executedSql || query.sql,
    result: latest.result,
    kind: latest.type === 'explain' ? 'explain' : latest.type === 'write' ? 'write' : 'query',
  }
}

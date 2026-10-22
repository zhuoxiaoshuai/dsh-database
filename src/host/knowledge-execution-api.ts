import type { ServerResponse } from 'node:http'
import type { ConnectionService } from './connection-service.ts'
import type { ExecutionStore } from './execution-store.ts'
import { DEFAULT_QUERY_PAGE_SIZE } from '../shared/limits.ts'

/** Two messages on the original response: cancellation uses execution-cancel, never this response. */
export async function knowledgeExecutionApi(service: ConnectionService, executions: ExecutionStore, owner: string,
  body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const input = body.input as { sql?: unknown; schema?: unknown } | undefined
  if (typeof body.id !== 'string' || typeof body.generation !== 'string' || typeof body.requestId !== 'string'
    || !/^[a-zA-Z0-9-]{1,80}$/.test(body.requestId) || !input || typeof input.sql !== 'string' || typeof input.schema !== 'string') throw new Error('经验库执行请求无效。')
  const controller = new AbortController()
  const cancel = () => { if (!res.writableEnded) controller.abort() }
  res.once('close', cancel)
  if (res.destroyed) controller.abort()
  const identity = { requestId: body.requestId, connectionId: body.id, generation: body.generation, schema: input.schema }
  const write = (value: object) => {
    if (res.destroyed) return
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
    res.write(JSON.stringify({ ...identity, ...value }) + '\n')
  }
  let executionId: string | undefined
  try {
    // Existing records are read-only reconciliation targets; never repeat an accepted request.
    const previous = executions.knowledgeRequest(owner, body.requestId, body.id, body.generation, input.schema)
    if (previous) throw Object.assign(new Error('此请求已经受理，请读取原执行回执。'), { executionId: previous.executionId, effect: 'unknown', phase: 'receipt' })
    const reply = await service.executeText(owner, body.id, body.generation, input.sql, controller.signal, 'user', body.requestId,
      undefined, undefined, { schema: input.schema }, {
        sql: { sourceKind: 'sql', entry: 'knowledge', input: { sql: input.sql, schema: input.schema, limit: DEFAULT_QUERY_PAGE_SIZE } },
        onCreated: id => { executionId = id; write({ type: 'accepted', executionId: id }) },
      })
    write({ type: 'result', executionId, result: { ...(reply.result as object), executionId, executionStatus: reply.status } })
  } catch (caught) {
    const error = caught as Error & { effect?: string; phase?: string; executionStatus?: string; executionId?: string; steps?: unknown; batch?: unknown; code?: string }
    write({ type: 'error', executionId: error.executionId || executionId, error: error.message || '执行失败。',
      effect: error.effect || (executionId ? 'unknown' : 'none'), phase: error.phase || (executionId ? 'receipt' : 'check'),
      status: error.executionStatus, code: error.code, steps: error.steps, batch: error.batch })
  } finally {
    res.off('close', cancel)
    if (!res.destroyed) res.end()
  }
}

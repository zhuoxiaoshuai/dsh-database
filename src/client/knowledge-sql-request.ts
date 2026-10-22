import type { Connection, Result } from '../shared/workbench.ts'
import { transportRequestError } from '../shared/connection-errors.ts'
import { validExecutionReply, validSteps } from './execution-reply.ts'
import type { ExecutionRecord } from '../shared/execution.ts'

type Request = (body?: unknown, signal?: AbortSignal) => Promise<unknown>
type Frame = { type: string; requestId?: string; executionId?: string; connectionId?: string; generation?: string; schema?: string;
  result?: Result & { executionId?: string; executionStatus?: string }; error?: string; effect?: string; phase?: string; status?: string; steps?: Result['steps']; batch?: Result[] }

export async function executeKnowledgeRequest(endpoint: string, request: Request, connection: Connection, sql: string,
  options: { signal: AbortSignal; stopSignal: AbortSignal }): Promise<Result & { executionStatus?: string; executionId?: string }> {
  const { signal, stopSignal } = options
  const requestId = crypto.randomUUID()
  const body = { action: 'sql-knowledge-run', id: connection.id, generation: connection.generation, requestId, input: { sql, schema: connection.database } }
  if (signal.aborted || stopSignal.aborted) throw Object.assign(new Error('未派发，已取消。'), { effect: 'none', phase: 'check', requestPhase: 'before-fetch', executionStatus: 'cancelled' })
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 524288) throw Object.assign(new Error('请求超过 512 KiB，未派发。'), { effect: 'none', phase: 'check' })
  let executionId: string | undefined, cancelSent = '', cancelError = ''
  const cancel = () => {
    if (!executionId || cancelSent === executionId || signal.aborted) return
    cancelSent = executionId
    void request({ action: 'execution-cancel', executionId }, signal).catch(error => { cancelError = error instanceof Error ? error.message : '停止请求未确认。' })
  }
  stopSignal.addEventListener('abort', cancel)
  const identity = (value: Frame) => value.requestId === requestId && value.connectionId === connection.id
    && value.generation === connection.generation && value.schema === connection.database
  const failure = (message: string) => transportRequestError(message, connection.id, 'response')
  const validBatch = (batch: unknown) => batch === undefined || Array.isArray(batch) && batch.every(item => !!item && typeof item === 'object' && validExecutionReply(item, 'manual-query'))
  const validTerminal = (frame: Frame) => frame.type === 'result' && !!frame.result && validExecutionReply(frame.result, 'manual-query') && validBatch(frame.result.batch)
    && frame.result.executionId === executionId && ['succeeded', 'failed', 'cancelled', 'unknown'].includes(frame.result.executionStatus || '')
    || frame.type === 'error' && typeof frame.error === 'string' && ['none', 'unknown', 'committed'].includes(frame.effect || '')
    && ['check', 'execute', 'commit', 'receipt'].includes(frame.phase || '') && validSteps(frame.steps) && validBatch(frame.batch)
  const decode = (frame: Frame) => {
    if (!validTerminal(frame)) throw failure('执行终态缺少可信回执，结果未知。')
    if (frame.type === 'result' && frame.result) {
      if (frame.result.executionStatus === 'succeeded') return frame.result
      throw Object.assign(new Error(frame.result.message || '执行未成功完成。'), { trustedReceipt: true, effect: frame.result.executionStatus === 'unknown' ? 'unknown' : 'none', phase: 'receipt',
        executionId, executionStatus: frame.result.executionStatus, steps: frame.result.steps, batch: frame.result.batch })
    }
    if (frame.type === 'error') {
      throw Object.assign(new Error(frame.error), { trustedReceipt: true, effect: frame.effect, phase: frame.phase,
        executionId, executionStatus: frame.status, steps: frame.steps, batch: frame.batch,
        ...(frame.status === 'cancelled' && frame.effect === 'none' ? { requestPhase: 'before-fetch' } : {}) })
    }
    throw failure('执行终态缺少可信回执，结果未知。')
  }
  const recover = async (): Promise<Frame> => {
    const deadline = Date.now() + 10000
    let last: (ExecutionRecord & { result?: Result; receiptPending?: boolean }) | undefined
    let revision = 0
    const reads = new AbortController(), abortReads = () => reads.abort()
    signal.addEventListener('abort', abortReads, { once: true })
    const deadlineTimer = setTimeout(abortReads, 10000)
    try {
      while (!signal.aborted && !reads.signal.aborted && Date.now() < deadline) {
        try {
          const record = await request({ action: 'execution-get', ...(executionId ? { executionId } : { requestId, id: connection.id, generation: connection.generation, schema: connection.database }) }, reads.signal) as NonNullable<typeof last>
          if (record.operation !== 'knowledge_sql_execute' || record.callId !== requestId || record.connectionId !== connection.id
            || record.generation !== connection.generation || record.schema !== connection.database) throw failure('执行回执身份不匹配。')
          if (typeof record.executionId !== 'string') throw failure('执行回执缺少身份。')
          executionId = record.executionId; last = record
          if (stopSignal.aborted) cancel()
          if (record.receiptPending === false && ['succeeded', 'failed', 'cancelled', 'unknown'].includes(record.status)) {
            if (record.status === 'succeeded' && record.result && !record.result.truncated) return { type: 'result', executionId, result: { ...record.result, executionId, executionStatus: 'succeeded' } }
            return { type: 'error', executionId, status: record.status === 'succeeded' ? 'unknown' : record.status,
              effect: record.status === 'cancelled' || record.status === 'failed' && !record.events?.some((event: { kind?: string }) => event.kind === 'dispatched') ? 'none' : 'unknown', phase: 'receipt',
              error: `${record.message || '已恢复所属执行回执。'}${record.result?.truncated ? ' 恢复回执已截断，缺失步骤不能推断。' : ''}`,
              steps: record.result?.steps, batch: record.result?.batch }
          }
        } catch { /* Only retry reads. Never repeat the SQL request. */ }
        const remaining = deadline - Date.now()
        if (remaining <= 0 || signal.aborted || reads.signal.aborted) break
        // The existing conversation wait is event driven; cap each wait by the recovery deadline.
        const wait = new AbortController(), abortWait = () => wait.abort()
        reads.signal.addEventListener('abort', abortWait, { once: true })
        const timer = setTimeout(abortWait, Math.min(remaining, 1000))
        try {
          const next = await request({ action: 'execution-wait', revision }, wait.signal) as { revision?: number }
          if (typeof next.revision === 'number') revision = next.revision
        } catch { /* bounded read */ }
        finally { clearTimeout(timer); reads.signal.removeEventListener('abort', abortWait) }
      }
      return { type: 'error', executionId, status: 'unknown', effect: 'unknown', phase: 'receipt',
        error: `回执未能完整恢复，执行结果未知，请核验，勿重复提交。${cancelError}`, steps: last?.result?.steps, batch: last?.result?.batch }
    } finally { clearTimeout(deadlineTimer); signal.removeEventListener('abort', abortReads) }
  }
  try {
    let terminal: Frame | undefined
    try {
      const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!response.ok || !response.body || !response.headers.get('Content-Type')?.startsWith('application/x-ndjson')) throw failure('未收到有效的执行受理响应。')
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let buffer = ''
      try {
        while (true) {
          const chunk = await reader.read()
          buffer += decoder.decode(chunk.value, { stream: !chunk.done })
          let newline: number
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
            if (!line.trim()) continue
            const frame = JSON.parse(line) as Frame
            if (!identity(frame) || terminal) throw failure('执行响应身份或顺序无效。')
            if (frame.type === 'accepted') {
              if (executionId || typeof frame.executionId !== 'string' || !frame.executionId) throw failure('执行受理身份无效。')
              executionId = frame.executionId
              if (stopSignal.aborted) cancel()
            } else {
              if (frame.executionId !== executionId && (executionId || frame.effect !== 'none')) throw failure('终态不属于本次执行。')
              if (!validTerminal(frame)) throw failure('执行终态缺少可信回执，正在读取所属执行记录。')
              terminal = frame
            }
          }
          if (chunk.done) break
        }
        if (buffer.trim() || !terminal) throw failure('执行响应中断，正在读取所属回执。')
      } finally { reader.releaseLock() }
    } catch (error) {
      if (signal.aborted) throw error
      terminal = await recover()
    }
    return decode(terminal!)
  } finally { stopSignal.removeEventListener('abort', cancel) }
}

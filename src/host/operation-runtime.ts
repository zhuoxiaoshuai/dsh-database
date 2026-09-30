import type { ExecutionStore } from './execution-store.ts'
import { databaseErrorDetail } from './connect-error.mjs'

export interface OperationBinding {
  owner: string
  connectionId: string
  generation: string
  connectionName: string
  sourceId: string
  environment: string
}

export async function runOperation<T extends object>(executions: ExecutionStore | undefined, binding: OperationBinding, metadata: {
  operation: string; title: string; initiator: 'user' | 'ai'; callId?: string; queryRevision?: number
  rootCallId?: string
}, authorizedWork: (signal: AbortSignal) => Promise<T>, summarize: (result: T) => string, externalSignal?: AbortSignal,
  classifyResult?: (result: T) => 'succeeded' | 'failed' | 'cancelled'): Promise<T & { executionId?: string; executionStatus: 'succeeded' | 'failed' | 'cancelled' }> {
  if (externalSignal?.aborted) throw new Error('请求已取消。')
  const controller = new AbortController()
  const cancel = () => controller.abort()
  externalSignal?.addEventListener('abort', cancel, { once: true })
  const record = executions?.create({ conversationId: binding.owner, connectionId: binding.connectionId, generation: binding.generation,
    connectionName: binding.connectionName, dialect: binding.sourceId, environment: binding.environment,
    operation: metadata.operation, title: metadata.title, initiator: metadata.initiator, callId: metadata.callId, rootCallId: metadata.rootCallId,
    queryRevision: metadata.queryRevision, historyVisible: true, type: 'query' })
  if (record) {
    executions?.attachAbort(record.executionId, controller)
    executions?.event(record.executionId, 'check-passed')
    executions?.transition(record.executionId, 'running')
  }
  try {
    const result = await authorizedWork(controller.signal)
    const executionStatus = controller.signal.aborted ? 'cancelled' : classifyResult?.(result) || 'succeeded'
    if (record) executions?.complete(record.executionId, executionStatus, summarize(result))
    return { ...result, ...(record ? { executionId: record.executionId } : {}), executionStatus }
  } catch (error) {
    if (record) executions?.complete(record.executionId, controller.signal.aborted ? 'cancelled' : 'failed', databaseErrorDetail(error, { maxLength: 300 }) || '操作失败。')
    throw error
  } finally {
    externalSignal?.removeEventListener('abort', cancel)
  }
}

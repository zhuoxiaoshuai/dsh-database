import { executionStop, isHostQueryTimeout } from '../shared/execution.ts'
import { runLocalOperation, type LocalOperationContext, type LocalOperationFailure, type LocalOperationOutcome, type OperationLifecycle } from './operation-runtime.ts'
import type { Connection } from '../shared/workbench.ts'
import type { ExecutionStore } from './execution-store.ts'

type LocalToolOperation = 'database_import_connections' | 'database_templates' | 'database_read_collab'
type LocalToolExecution = { signal?: AbortSignal; callId?: string; rootCallId?: string }

// Preserve the old local-tool failure contract; Worker operations keep their own classifiers.
function localFailure(error: unknown, lifecycle: OperationLifecycle): LocalOperationFailure {
  const message = error instanceof Error ? error.message : '操作失败'
  const stop = executionStop({ ...lifecycle, message })
  const thrown = error instanceof Error ? error : new Error(message)
  if (isHostQueryTimeout(message)) return { status: 'failed', message, error: thrown }
  if (stop.status !== 'failed') return { status: stop.status, message: stop.message, error: thrown }
  if (/超时|timeout/i.test(message)) return { status: 'unknown', message, error: thrown, event: 'timeout' }
  if (/连接已关闭|连接已变化/.test(message)) return { status: 'unknown', message, error: thrown, event: 'disconnect' }
  return { status: 'failed', message, error: thrown }
}

export function runLocalAiOperation<T>(executions: ExecutionStore, execution: LocalToolExecution, session: string,
  connection: Connection | undefined, operation: LocalToolOperation,
  details: { title: string; reason?: string; sql?: string; draft?: Record<string, unknown> },
  work: (context: LocalOperationContext, signal: AbortSignal) => Promise<LocalOperationOutcome<T>>): Promise<T> {
  return runLocalOperation(executions, { owner: session, connection }, {
    ...details, operation, initiator: 'ai', type: 'tool', historyVisible: false,
    callId: typeof execution.callId === 'string' ? execution.callId : '',
    rootCallId: typeof execution.rootCallId === 'string' ? execution.rootCallId : '',
  }, (signal, context) => work(context, signal), execution.signal, localFailure)
}

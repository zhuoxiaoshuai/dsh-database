import type { ExecutionStore } from './execution-store.ts'
import { nativeErrorText } from './connect-error.mjs'
import type { ExecutionType, DocumentExecutionIdentity } from '../shared/execution.ts'
import type { Result } from '../shared/workbench.ts'

export type OperationStatus = 'succeeded' | 'failed' | 'cancelled' | 'unknown'
export type OperationLifecycle = { aborted: boolean; dispatched: boolean }
export type OperationMetadata = {
  operation: string; title: string; initiator: 'user' | 'ai'; callId?: string; queryRevision?: number
  rootCallId?: string; type?: ExecutionType; historyVisible?: boolean
  schema?: string; tables?: string[]; sql?: string; executedSql?: string; draft?: Record<string, unknown>
  documentText?: string
  context?: Record<string, string>
  identity?: DocumentExecutionIdentity
  reason?: string; conclusion?: string
}
export type OperationContext = { executionId?: string; markChecked(): void }
export interface OperationBinding {
  owner: string
  connectionId: string
  generation: string
  connectionName: string
  sourceId: string
  environment: string
}
export interface OperationOptions<T> {
  classifyInterruption?(error: unknown, lifecycle: OperationLifecycle): OperationStatus
  completedResultIsDefinitive?: boolean
  summarizeFailure?(error: unknown, lifecycle: OperationLifecycle, status: OperationStatus): string
  deferCheckPassed?: boolean
  projectCompletion?(result: T): { message?: string; result?: Result; conclusion?: string }
  onFinished?(executionId: string | undefined, status: OperationStatus, result?: T, message?: string): void
}

export interface LocalOperationBinding {
  owner: string
  connection?: { id: string; generation?: string; name: string; dialect?: string; environment?: string }
}
export type LocalOperationContext = {
  executionId: string
  markChecked(): void
  markRunning(): void
  annotate(patch: { sql?: string; draft?: Record<string, unknown> }): void
}
export type LocalOperationOutcome<T> = { value: T; message?: string; conclusion?: string }
export type LocalOperationFailure = {
  status: OperationStatus; message: string; error: Error; event?: 'timeout' | 'disconnect'
}
type LifecycleContext = OperationContext & Omit<LocalOperationContext, 'executionId'>
type LifecycleOptions<T> = OperationOptions<T> & {
  projectFailure?(error: unknown, lifecycle: OperationLifecycle): LocalOperationFailure
}

/** Local work has no Worker dispatch marker or live-connection requirement. */
export async function runLocalOperation<T>(executions: ExecutionStore, binding: LocalOperationBinding, metadata: OperationMetadata,
  work: (signal: AbortSignal, context: LocalOperationContext) => Promise<LocalOperationOutcome<T>>, externalSignal?: AbortSignal,
  projectFailure?: LifecycleOptions<LocalOperationOutcome<T>>['projectFailure']): Promise<T> {
  const connection = binding.connection
  const outcome = await runLifecycle(executions, { owner: binding.owner, connectionId: connection?.id,
    generation: connection?.generation, connectionName: connection?.name, sourceId: connection?.dialect, environment: connection?.environment },
  { ...metadata, type: 'tool', historyVisible: false }, (signal, _markDispatched, context) => {
    if (!context.executionId) throw new Error('执行记录创建失败。')
    return work(signal, { ...context, executionId: context.executionId })
  }, result => result.message || '', externalSignal, undefined, {
    deferCheckPassed: true, completedResultIsDefinitive: true,
    projectCompletion: result => ({ message: result.message, conclusion: result.conclusion }), projectFailure,
  })
  return outcome.value
}

export async function runOperation<T extends object>(executions: ExecutionStore | undefined, binding: OperationBinding, metadata: OperationMetadata,
  authorizedWork: (signal: AbortSignal, markDispatched: () => void, context: OperationContext) => Promise<T>, summarize: (result: T) => string, externalSignal?: AbortSignal,
  classifyResult?: (result: T) => OperationStatus, options: OperationOptions<T> = {}): Promise<T & { executionId?: string; executionStatus: OperationStatus }> {
  return runLifecycle(executions, binding, metadata, authorizedWork, summarize, externalSignal, classifyResult, options)
}

async function runLifecycle<T extends object>(executions: ExecutionStore | undefined, binding: Pick<OperationBinding, 'owner'> & Partial<Omit<OperationBinding, 'owner'>>, metadata: OperationMetadata,
  authorizedWork: (signal: AbortSignal, markDispatched: () => void, context: LifecycleContext) => Promise<T>, summarize: (result: T) => string, externalSignal?: AbortSignal,
  classifyResult?: (result: T) => OperationStatus, options: LifecycleOptions<T> = {}): Promise<T & { executionId?: string; executionStatus: OperationStatus }> {
  if (externalSignal?.aborted) throw new Error('请求已取消。')
  const controller = new AbortController()
  const cancel = () => controller.abort()
  externalSignal?.addEventListener('abort', cancel, { once: true })
  let record: { executionId: string } | undefined
  let dispatched = false
  let checked = false
  let running = false
  let finished = false
  const publishFinished = (status: OperationStatus, result?: T, message?: string) => {
    if (finished) return
    finished = true
    options.onFinished?.(record?.executionId, status, result, message)
  }
  const lifecycle = () => ({ aborted: controller.signal.aborted, dispatched })
  const isTerminal = () => {
    const status = record && executions?.get?.(binding.owner, record.executionId)?.status
    return !!status && ['succeeded', 'failed', 'cancelled', 'unknown'].includes(status)
  }
  const markChecked = () => {
    if (checked || isTerminal()) return
    checked = true
    if (record) executions?.event(record.executionId, 'check-passed')
  }
  const markDispatched = () => {
    if (dispatched) return
    dispatched = true
    if (record && !isTerminal()) { executions?.transition(record.executionId, 'running'); executions?.event(record.executionId, 'dispatched') }
  }
  const markRunning = () => {
    if (running || isTerminal()) return
    running = true
    if (record) executions?.transition(record.executionId, 'running')
  }
  const annotate: LocalOperationContext['annotate'] = patch => {
    if (record && !isTerminal()) executions?.annotate(record.executionId, { sql: patch.sql, draft: patch.draft })
  }
  const actualStatus = (proposed: OperationStatus): OperationStatus => {
    const status = record && executions?.get?.(binding.owner, record.executionId)?.status
    return status && ['succeeded', 'failed', 'cancelled', 'unknown'].includes(status) ? status as OperationStatus : proposed
  }
  try {
    record = executions?.create({ conversationId: binding.owner, connectionId: binding.connectionId, generation: binding.generation,
      connectionName: binding.connectionName, dialect: binding.sourceId, environment: binding.environment,
      operation: metadata.operation, title: metadata.title, initiator: metadata.initiator, callId: metadata.callId, rootCallId: metadata.rootCallId,
      queryRevision: metadata.queryRevision, historyVisible: metadata.historyVisible ?? true, type: metadata.type || 'query',
      documentText: metadata.documentText, context: metadata.context, identity: metadata.identity,
      schema: metadata.schema, tables: metadata.tables, sql: metadata.sql, executedSql: metadata.executedSql,
      draft: metadata.draft, reason: metadata.reason, conclusion: metadata.conclusion })
    if (record) {
      executions?.attachAbort(record.executionId, controller)
      if (!options.deferCheckPassed) markChecked()
      executions?.transition(record.executionId, 'checking')
    }
    if (controller.signal.aborted) throw new Error('请求已取消。')
    const result = await authorizedWork(controller.signal, markDispatched, { executionId: record?.executionId, markChecked, markRunning, annotate })
    const proposed = controller.signal.aborted && !options.completedResultIsDefinitive
      ? options.classifyInterruption?.(undefined, lifecycle()) || 'cancelled'
      : classifyResult?.(result) || 'succeeded'
    const completion = options.projectCompletion?.(result)
    if (record) {
      if (completion) executions?.complete(record.executionId, proposed, completion.message, completion.result, completion.conclusion)
      else executions?.complete(record.executionId, proposed, summarize(result))
    }
    const executionStatus = actualStatus(proposed)
    const actualMessage = record && executions?.get?.(binding.owner, record.executionId)?.message
    publishFinished(executionStatus, result, actualMessage || completion?.message)
    return { ...result, ...(record ? { executionId: record.executionId } : {}), executionStatus }
  } catch (error) {
    const failure = options.projectFailure?.(error, lifecycle())
    const proposed = failure?.status || options.classifyInterruption?.(error, lifecycle()) || (controller.signal.aborted ? 'cancelled' : 'failed')
    const message = failure?.message ?? options.summarizeFailure?.(error, lifecycle(), actualStatus(proposed))
      ?? (proposed === 'unknown' ? '操作结果未知，请核验。' : nativeErrorText(error, '操作失败。'))
    if (record && failure?.event && !isTerminal()) executions?.event(record.executionId, failure.event, message)
    const receipt = error as { steps?: Result['steps']; batch?: Result[] } | undefined
    const partial = Array.isArray(receipt?.steps) ? { columns: [], rows: [], truncated: false, elapsedMs: 0, message, steps: receipt.steps, batch: receipt.batch } : undefined
    if (record) executions?.complete(record.executionId, proposed, message, partial)
    const actualMessage = record && executions?.get?.(binding.owner, record.executionId)?.message
    publishFinished(actualStatus(proposed), undefined, actualMessage || message)
    const rejected = failure?.error ?? error
    if (!dispatched && rejected && typeof rejected === 'object') Object.assign(rejected, { effect: (rejected as {effect?: string}).effect || 'none', phase: (rejected as {phase?: string}).phase || 'check' })
    if (rejected && typeof rejected === 'object') Object.assign(rejected, { executionId: record?.executionId, executionStatus: actualStatus(proposed) })
    throw rejected
  } finally {
    externalSignal?.removeEventListener('abort', cancel)
    if (record) executions?.releaseAbort?.(record.executionId, controller)
  }
}

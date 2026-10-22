import type { Connection, Result } from '../shared/workbench.ts'
import type { ExecutionDocument } from '../shared/execution-document.ts'
import type { DocumentExecutionIdentity, ExecutionType } from '../shared/execution.ts'
import { CONNECTION_ERROR_CODES, ServiceError } from '../shared/connection-errors.ts'
import { hostModules } from './data-sources/modules.ts'
import { prepareTextOperation, authorizeTextOperation } from './text-execution.ts'
import type { PreparedTextOperation, TextEntryOptions } from './data-sources/module-types.ts'
import type { ExecutionStore } from './execution-store.ts'
import { runOperation } from './operation-runtime.ts'
import { sqlOperationBinding, sqlOperationMetadata, sqlCompletion, sqlModel, sqlFailureMessage } from './sql-operation.ts'
const fail = (message: string, code: typeof CONNECTION_ERROR_CODES[keyof typeof CONNECTION_ERROR_CODES]) => new ServiceError(message, code)

export interface TextOperationPort {
  executions?: ExecutionStore
  valid(owner: string): boolean
  connection(id: string): Connection | undefined
  document(owner: string, id: string, generation?: unknown): ExecutionDocument
  acquireRun(id: string): string
  releaseRun(id: string, lease: string): void
  send(owner: string, id: string, generation: unknown, prepared: PreparedTextOperation, signal?: AbortSignal, hooks?: { beforeDispatch?(): void; onDispatched?(): void }): Promise<Record<string, unknown>>
}

/** Uses the existing operation runtime; this runner creates no second queue or state machine. */
export class TextOperationRunner {
  private readonly port: TextOperationPort
  constructor(port: TextOperationPort) { this.port = port }
  async run(session: string, id: string, generation: unknown, text: unknown, signal?: AbortSignal, initiator: 'user' | 'ai' = 'user', callId?: string, queryRevision?: number, rootCallId?: string, context?: unknown, options?: { type?: ExecutionType; sql?: TextEntryOptions; onCreated?(executionId: string): void }): Promise<Record<string, unknown>> {
    const connection = this.port.connection(id)
    const entry = connection ? { connection } : undefined
    if (!entry || !this.port.valid(session) || entry.connection.generation !== generation) throw fail('连接已变化或当前对话已失效，请刷新。', CONNECTION_ERROR_CODES.stale)
    if (options?.sql?.entry === 'knowledge' && !['mysql', 'oracle'].includes(entry.connection.dialect)) throw new Error('此入口只支持 SQL 经验库。')
    const execution = hostModules.get(entry.connection.dialect).execution
    if (!execution) throw new Error('此数据源不支持此能力。')
    const normalized = execution.normalizeContext(context, entry.connection)
    const document = queryRevision === undefined ? undefined : this.port.document(session, id, generation)
    const prepared = await prepareTextOperation(execution, text, normalized, options?.sql, signal)
    const sql = prepared.sourceKind === 'sql'
    const knowledge = sql && options?.sql?.entry === 'knowledge'
    if (knowledge && !this.port.executions) throw new Error('执行回执服务不可用，未派发。')
    const identity: DocumentExecutionIdentity | undefined = document ? { conversationId: session, connectionId: id, generation: entry.connection.generation!, sourceId: entry.connection.dialect,
      context: { ...normalized }, queryRevision: document.revision, documentText: document.text, executedSql: prepared.text, initiator } : undefined
    const validate = () => {
      if (!document) return
      const now = this.port.document(session, id, generation)
      if (now.revision !== queryRevision || now.controller !== initiator || now.text !== document.text || JSON.stringify(now.context) !== JSON.stringify(document.context)) throw new Error('AI Query 已被修改、接管或切换目标，操作没有发出。')
    }
    const send = (workSignal?: AbortSignal, onDispatched?: () => void) => this.port.send(session, id, generation, prepared, workSignal, { beforeDispatch: validate, onDispatched })
    if (prepared.recordPolicy === 'none') {
      await authorizeTextOperation(execution, prepared, initiator, entry.connection, options?.sql, signal)
      return send(signal)
    }
    let kind: 'query' | 'write' | 'explain' = options?.type === 'explain' ? 'explain' : 'query'
    const show = options?.type !== 'verify'
    const metadata = sql ? sqlOperationMetadata({ schema: normalized.schema, sql: prepared.text, revision: queryRevision!, initiator, type: options?.type || 'query', callId, rootCallId, documentText: document?.text, explain: options?.type === 'explain' })
      : { operation: prepared.operation, title: prepared.title, initiator, callId, queryRevision, rootCallId, type: options?.type }
    const lease = sql && options?.type !== 'verify' ? this.port.acquireRun(id) : undefined
    try {
      const response = await runOperation(this.port.executions, sqlOperationBinding(session, entry.connection), { ...metadata, ...(knowledge ? { operation: 'knowledge_sql_execute', historyVisible: false, reason: '用户在经验库执行当前 SQL。' } : {}), identity, context: normalized }, async (workSignal, onDispatched, operation) => {
        const authorization = await authorizeTextOperation(execution, prepared, initiator, entry.connection, options?.sql, workSignal)
        if (sql && authorization) {
          kind = authorization.kind === 'write' ? 'write' : authorization.kind === 'explain' ? 'explain' : kind
          if (identity) identity.executedSql = prepared.text
          if (operation.executionId) this.port.executions?.annotate(operation.executionId, { identity, sql: prepared.text, executedSql: prepared.text, tables: authorization.tables, type: kind === 'query' ? options?.type || 'query' : kind })
        }
        operation.markChecked()
        validate()
        if (identity && show) this.port.executions?.emitWorkbench(session, { type: 'EXECUTION_STARTED', ...identity, identity, executionId: operation.executionId })
        return send(workSignal, onDispatched)
      }, prepared.summarize, signal, prepared.classifyResult, {
        onCreated: options?.onCreated, deferCheckPassed: true, classifyInterruption: (error, lifecycle) => prepared.classifyInterruption?.(error, lifecycle) ?? (lifecycle.dispatched ? 'unknown' : lifecycle.aborted ? 'cancelled' : 'failed'),
        completedResultIsDefinitive: prepared.completedResultIsDefinitive,
        recoverPartialResult: prepared.recoverPartialResult,
        summarizeFailure: sql ? sqlFailureMessage : (_error, _state, status) => status === 'unknown' ? (entry.connection.dialect === 'kafka' ? '执行结果未知，请核对目标 Topic，勿重复提交。' : 'Redis 执行结果未知，请核验，勿重复提交。') : _error instanceof Error ? _error.message : '执行失败。',
        projectCompletion: sql ? result => sqlCompletion(result as unknown as Result, kind, options?.type === 'explain') : (result, status) => ({ message: prepared.summarize(result), resultEnvelope: {
          sourceId: entry.connection.dialect, kind: prepared.sourceKind, status, truncated: result.truncated === true,
          payload: prepared.projectLiveResult ? prepared.projectLiveResult({ ...result, executionStatus: status }) : { ...result, executionStatus: status },
        } }),
        onFinished: (executionId, status, result, message) => {
          if (!identity || !show || !executionId) return
          try { validate() } catch { return }
          const stored = this.port.executions?.get(session, executionId, true)
          this.port.executions?.emitWorkbench(session, { type: !sql || status === 'succeeded' ? 'EXECUTION_FINISHED' : 'EXECUTION_FAILED', ...identity, identity, executionId, status, kind, message,
            ...(sql ? { result: status === 'unknown' ? (stored?.result || { columns: [], rows: [], elapsedMs: 0, truncated: false, message }) : (stored?.result || result) as Result } : { sourceResult: result && prepared.projectLiveResult ? prepared.projectLiveResult({ ...result, executionStatus: status }) : { kind: 'error', message, executionStatus: status } }) })
        },
      })
      const { executionStatus: status, ...result } = response
      const receipt = knowledge ? this.port.executions?.get(session, result.executionId as string, true)?.result : result
      if (status === 'unknown') throw Object.assign(new Error(this.port.executions?.get(session, result.executionId as string)?.message || '执行结果未知，请核验，勿重复提交。'), { effect: 'unknown', phase: 'receipt', executionId: result.executionId, executionStatus: status, steps: receipt?.steps, batch: receipt?.batch,
        ...(prepared.sourceKind === 'kafka' && result.kind === 'produce-batch' ? { sourceResult: prepared.projectLiveResult ? prepared.projectLiveResult({ ...result, executionStatus: status }) : { ...result, executionStatus: status } } : {}) })
      if (!sql) return { ...(prepared.projectLiveResult ? prepared.projectLiveResult(response) : response), ...(identity ? { ...identity, identity, result: prepared.projectLiveResult ? prepared.projectLiveResult(response) : response } : {}) }
      return { ...(identity || {}), ...(identity ? { identity } : {}), schema: normalized.schema, ...(identity && this.port.document(session, id).revision !== identity.queryRevision ? { controlLost: true } : {}), executionId: result.executionId, status, kind, sql: prepared.text, result, model: sqlModel(result as unknown as Result, result.executionId as string, !!document && this.port.document(session, id).revision !== document.revision) }
    } catch (error) {
      const partial = prepared.recoverPartialResult?.(error)
      if (partial && error && typeof error === 'object') Object.assign(error, { sourceResult: { ...partial, executionStatus: (error as { executionStatus?: string }).executionStatus || 'unknown' } })
      if (error && typeof error === 'object') Object.assign(error, { ...(identity || {}), ...(identity ? { identity } : {}), kind, schema: normalized.schema })
      if (error instanceof Error && (error as {executionId?: string}).executionId) { const message = this.port.executions?.get(session, (error as Error & {executionId: string}).executionId)?.message; if (message) error.message = message }
      throw error
    } finally { if (lease !== undefined) this.port.releaseRun(id, lease) }
  }
}

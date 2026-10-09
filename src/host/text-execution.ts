import type { Connection } from '../shared/workbench.ts'
import type { HostSourceModule, PreparedTextOperation, TextEntryOptions } from './data-sources/module-types.ts'
import { ServiceError, CONNECTION_ERROR_CODES } from '../shared/connection-errors.ts'

type TextExecution = Extract<HostSourceModule['execution'], { mode: 'standard-text' }>
export type TextDispatchScope = { policy: 'none'; signal?: AbortSignal; beforeDispatch?(): void }
  | { policy: 'external'; signal: AbortSignal; onDispatched(): void; beforeDispatch?(): void }
export type TextDispatcher = (prepared: PreparedTextOperation, scope: TextDispatchScope) => Promise<Record<string, unknown>>

function beforeDispatchFailure(error: unknown): never {
  if (error && typeof error === 'object') Object.assign(error, { effect: 'none', phase: 'check' })
  throw error
}

function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new ServiceError('请求已取消。', CONNECTION_ERROR_CODES.cancelled)
}

export async function prepareTextOperation(execution: TextExecution, text: unknown, context: Record<string, string>, options?: TextEntryOptions, signal?: AbortSignal) {
  checkCancelled(signal)
  const prepared = await Promise.resolve().then(() => execution.prepareText(text, context, options)).catch(beforeDispatchFailure)
  checkCancelled(signal)
  if (!prepared || !['none', 'owned', 'external'].includes(prepared.recordPolicy ?? 'owned')
    || !['manual', 'ai'].includes(prepared.queue ?? 'manual')) throw new Error('数据源文本执行配置无效。')
  return prepared
}

export async function authorizeTextOperation(execution: TextExecution, prepared: PreparedTextOperation, actor: 'user' | 'ai', binding: Connection, options?: TextEntryOptions, signal?: AbortSignal) {
  checkCancelled(signal)
  const authorization = await Promise.resolve().then(() => execution.authorize(prepared, actor, binding, options)).catch(beforeDispatchFailure)
  checkCancelled(signal)
  return authorization
}

/** Transport owns no records and no second queue. Its caller supplies the one lifecycle. */
export async function dispatchTextOperation(prepared: PreparedTextOperation, scope: TextDispatchScope, dispatch: TextDispatcher) {
  checkCancelled(scope.signal)
  const policy = prepared.recordPolicy ?? 'owned'
  if (scope.policy === 'none' && policy !== 'none') throw new Error('此文本执行需要已有执行生命周期。')
  if (scope.policy === 'external' && (!scope.signal || typeof scope.onDispatched !== 'function')) throw new Error('缺少执行生命周期。')
  return dispatch(prepared, scope)
}

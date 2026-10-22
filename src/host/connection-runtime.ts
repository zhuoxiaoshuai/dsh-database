import type { Worker } from 'node:worker_threads'
import type { Connection } from '../shared/workbench.ts'
import type { ConnectionLifecycle } from '../shared/connection-lifecycle.ts'

export type ConnectionEntry = { session: string; worker: Worker; connection: Connection; touched: number; busy: number; cancelling?: number; unexpectedlyClosed?: boolean }
export type ConnectionAttempt = { session: string; projection: ConnectionLifecycle; controller: AbortController; worker?: Worker; promise: Promise<Connection>; signature: string }
export type ConnectionRuntimeState = { entry?: ConnectionEntry; attempt?: ConnectionAttempt; timer?: NodeJS.Timeout; retryAttempts: number; everReady: boolean; recoveryBlocked: boolean; epoch: number }

/** Shared physical connections outlive an individual conversation. */
export class ConnectionRuntime {
  readonly records = new Map<string, ConnectionRuntimeState>()
  readonly operations = new Map<string, { id: string; attempt: ConnectionAttempt }>()
  record(id: string): ConnectionRuntimeState {
    let state = this.records.get(id)
    if (!state) { state = { retryAttempts: 0, everReady: false, recoveryBlocked: false, epoch: 0 }; this.records.set(id, state) }
    return state
  }
  clearRetry(id: string): boolean {
    const state = this.records.get(id)
    if (!state) return false
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
    if (!state.attempt?.projection.nextRetryAt) return false
    delete state.attempt.projection.nextRetryAt
    return true
  }
  rememberOperation(operationId: string, id: string, attempt: ConnectionAttempt): void {
    this.operations.set(operationId, { id, attempt })
    while (this.operations.size > 1000) {
      const victim = [...this.operations].find(([, value]) => !['queued', 'running'].includes(value.attempt.projection.status))
      if (!victim) break
      this.operations.delete(victim[0])
    }
  }
  releaseOwner(owner: string): void {
    for (const [id, value] of this.operations) if (value.attempt.session === owner) this.operations.delete(id)
  }
  clear(): void {
    for (const id of this.records.keys()) this.clearRetry(id)
    this.records.clear(); this.operations.clear()
  }
}

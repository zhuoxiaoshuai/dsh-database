import type { DataSourceId } from '../../shared/data-sources/types.ts'
import type { Connection, SourceConnectionInput, SourceConnectionSettings } from '../../shared/workbench.ts'
import type { ExplorerProvider } from '../explorer-provider.ts'
import type { KnowledgeProvider } from '../knowledge-provider.ts'
import type { ConnectionService } from '../connection-service.ts'
import type { ExecutionStore } from '../execution-store.ts'
import type { RedactionRule } from '../ai-redaction.ts'
import type { OperationLifecycle, OperationStatus } from '../operation-runtime.ts'
import type { SqlTextEntryOptions, SqlPreparedState, SqlAuthorizedStatement } from './sql-execution.ts'

export interface HostSourceModule {
  id: DataSourceId
  family: 'sql' | 'redis' | 'kafka'
  runtime: { id: DataSourceId; workerEntry: string; actions: readonly string[] }
  connection: {
    validate(input: unknown, options?: { passwordOptional?: boolean }): SourceConnectionInput
    fingerprint(input: never): string
    sameLogin?(saved: SourceConnectionSettings, input: SourceConnectionInput): boolean
    requiresPassword?(input: SourceConnectionInput): boolean
    toSavedSettings?(input: SourceConnectionInput, caPem: string): SourceConnectionSettings
    normalizeStoredSettings(raw: SourceConnectionSettings): SourceConnectionSettings
  }
  ai: { key: string; register(ctx: { tools: { register(tool: unknown): void } }, service: ConnectionService,
    executions: ExecutionStore, validOwner: (id: string) => boolean, rules: RedactionRule[]): void }
  explorer: ExplorerProvider<DataSourceId>
  knowledge: KnowledgeProvider<DataSourceId>
  execution: StandardTextExecution
}

export interface StandardTextExecution {
  mode: 'standard-text'
  normalizeContext(raw: unknown, binding: Connection): Record<string, string>
  prepareText(text: unknown, context: Record<string, string>, options?: TextEntryOptions): PreparedTextOperation | Promise<PreparedTextOperation>
  authorize(prepared: PreparedTextOperation, actor: 'user' | 'ai', binding: Connection, options?: TextEntryOptions): void | SqlAuthorizedStatement | Promise<void | SqlAuthorizedStatement>
}

/** These entry and lifecycle choices are Host-only, never request-body fields. */
export type TextEntryOptions = SqlTextEntryOptions | { sourceKind: 'redis' | 'kafka' }
export type PreparedTextOperation = { action: string; text: string; input: Record<string, unknown>; operation: string; title: string;
  queue?: 'manual' | 'ai'; recordPolicy?: 'none' | 'owned' | 'external'
  summarize(result: Record<string, unknown>): string; classifyResult?(result: Record<string, unknown>): OperationStatus
  classifyInterruption?(error: unknown, lifecycle: OperationLifecycle): OperationStatus
  completedResultIsDefinitive?: boolean
  projectLiveResult?(result: Record<string, unknown>): Record<string, unknown> } & (SqlPreparedState | { sourceKind: 'redis' | 'kafka'; authorized?: never })

import type { DataSourceId } from '../../shared/data-sources/types.ts'
import type { Connection, SourceConnectionInput, SourceConnectionSettings } from '../../shared/workbench.ts'
import type { ExplorerProvider } from '../explorer-provider.ts'
import type { KnowledgeProvider } from '../knowledge-provider.ts'
import type { ConnectionService } from '../connection-service.ts'
import type { ExecutionStore } from '../execution-store.ts'
import type { RedactionRule } from '../ai-redaction.ts'

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
  execution: { mode: 'legacy-adapter'; normalizeContext?(raw: unknown, binding: Connection): Record<string, string> } | {
    mode: 'standard-text'
    normalizeContext(raw: unknown, binding: Connection): Record<string, string>
    prepareText(text: unknown, context: Record<string, string>): PreparedTextOperation
    authorize(prepared: PreparedTextOperation, actor: 'user' | 'ai', binding: Connection): void
  }
}

export type PreparedTextOperation = { action: string; text: string; input: Record<string, unknown>; operation: string; title: string;
  summarize(result: Record<string, unknown>): string; classifyResult?(result: Record<string, unknown>): 'succeeded' | 'failed' | 'cancelled' }

import type { DataSourceId } from './data-sources/types.ts'
import type { ExecutionStatus } from './execution.ts'

/** The shell owns status and paging; only the source interprets payload. */
export type ExecutionResultEnvelope<Payload = unknown> = {
  sourceId: DataSourceId
  kind: string
  status: ExecutionStatus
  elapsedMs?: number
  truncated: boolean
  nextCursor?: string
  payload: Payload
}

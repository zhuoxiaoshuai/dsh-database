/** Common transport header. Payload semantics belong to the selected source. */
export type WorkerReply<T = unknown> = {
  requestId?: string; ready?: boolean; ok?: boolean; cancelled?: boolean; closed?: boolean
  result?: T; error?: string; code?: string; category?: string; connectionCategory?: string
  health?: 'connecting' | 'ready' | 'degraded' | 'offline' | 'closed'; effect?: string; phase?: string; databaseCode?: string
  progress?: Record<string, unknown>; sqlProgress?: Record<string, unknown>; steps?: unknown; batch?: unknown
}
export function workerReplyHeaderValid(value: unknown): value is WorkerReply {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  for (const key of ['requestId', 'error', 'code', 'category', 'connectionCategory', 'health', 'effect', 'phase', 'databaseCode']) {
    if (row[key] !== undefined && typeof row[key] !== 'string') return false
  }
  for (const key of ['ready', 'ok', 'cancelled', 'closed']) if (row[key] !== undefined && typeof row[key] !== 'boolean') return false
  if (row.health !== undefined && !['connecting', 'ready', 'degraded', 'offline', 'closed'].includes(String(row.health))) return false
  if (row.sqlProgress !== undefined && (!row.sqlProgress || typeof row.sqlProgress !== 'object' || Array.isArray(row.sqlProgress))) return false
  return true
}

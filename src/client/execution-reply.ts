export function validExecutionReply(value: object, action?: string): boolean {
  const reply = value as Record<string, unknown>
  const sql = Array.isArray(reply.columns) && reply.columns.every(item => typeof item === 'string')
    && Array.isArray(reply.rows) && reply.rows.every(row => Array.isArray(row))
    && typeof reply.truncated === 'boolean' && typeof reply.elapsedMs === 'number'
  const payload = !!reply.result && typeof reply.result === 'object' && !Array.isArray(reply.result)
    || action === 'source-execute' && typeof reply.kind === 'string'
  return validSteps(reply.steps) && (sql || payload && typeof reply.executionId === 'string' && ['succeeded', 'failed', 'unknown', 'cancelled'].includes(String(reply.executionStatus ?? reply.status)))
}

export function validSteps(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  const indexes = new Set<number>()
  return value.every(step => {
    if (!step || typeof step !== 'object' || !Number.isSafeInteger(step.index) || step.index < 0 || indexes.has(step.index)
      || typeof step.sql !== 'string' || !['succeeded', 'failed', 'unknown', 'not-run'].includes(step.status)
      || step.affectedRows !== undefined && (typeof step.affectedRows !== 'number' || !Number.isFinite(step.affectedRows))) return false
    indexes.add(step.index); return true
  })
}

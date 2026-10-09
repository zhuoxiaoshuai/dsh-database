import type { Connection, WorkspaceBridge } from '../shared/workbench.ts'

export type UnknownGridWrite = { connectionId: string; connectionName: string; generation?: string; schema: string; table: string; sql: string; params: (string | null)[]; createdAt: string; previewId: string; executionId?: string }
export type DmlOp = { kind: 'insert' | 'update' | 'delete'; values: Record<string, string | null>; original?: Record<string, string | null>; draftId?: string; rowKey?: string; unknown?: boolean }

/** Consumes trusted successes immediately; an uncertain step can never be replayed. */
const savingOperations = new WeakSet<DmlOp[]>()
export async function saveDmlOperations(operations: DmlOp[], execute: (operation: DmlOp) => Promise<void>, committed: (operation: DmlOp) => void): Promise<void> {
  if (savingOperations.has(operations)) throw new Error('本次保存正在执行，请等待回执。')
  savingOperations.add(operations)
  try {
  while (operations.length) {
    const operation = operations[0]
    if (operation.unknown) throw Object.assign(new Error('上次写入结果未知，请核验并丢弃旧草稿后刷新；不能再次提交。'), { effect: 'unknown' })
    try { await execute(operation) }
    catch (error) { if ((error as { effect?: string })?.effect === 'unknown') operation.unknown = true; throw error }
    operations.shift(); committed(operation)
  }
  } finally { savingOperations.delete(operations) }
}

export async function executeDmlOp(
  bridge: WorkspaceBridge,
  connection: Connection,
  schema: string,
  table: string,
  operation: DmlOp,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const expired = () => Object.assign(new Error('执行目标或原结果已变化，修改未提交。'), { effect: 'none', phase: 'check' })
  if (!isCurrent()) throw expired()
  const preview = await bridge.maintenance!(connection, { kind: 'preview', schema, table, operation })
  if (!preview.id) throw new Error('无法预览变更')
  if (!isCurrent()) {
    await bridge.maintenance!(connection, { kind: 'reject', id: preview.id }).catch(() => {})
    throw expired()
  }
  const createdAt = new Date().toISOString()
  try {
    const result = await bridge.maintenance!(connection, { kind: 'execute', id: preview.id, confirmed: true })
    if (result.status !== 'success') throw Object.assign(new Error(result.message || '结果未知，请核验数据库实际状态。'), { effect: result.status === 'unknown' ? 'unknown' : 'none' })
  } catch (error) {
    await bridge.maintenance!(connection, { kind: 'reject', id: preview.id }).catch(() => {})
    if ((error as { effect?: string })?.effect === 'none') throw error
    throw Object.assign(error instanceof Error ? error : new Error('保存回执缺失。'), { effect: 'unknown', unknownWrite: { connectionId: connection.id, connectionName: connection.name, generation: connection.generation, schema, table,
      sql: preview.sql || '', params: preview.params || [], createdAt, previewId: preview.id, executionId: preview.executionId } satisfies UnknownGridWrite })
  }
}

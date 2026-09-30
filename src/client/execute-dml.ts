import type { Connection, WorkspaceBridge } from '../shared/workbench.ts'

export type DmlOp = { kind: 'insert' | 'update' | 'delete'; values: Record<string, string | null>; original?: Record<string, string | null> }

export async function executeDmlOp(
  bridge: WorkspaceBridge,
  connection: Connection,
  schema: string,
  table: string,
  operation: DmlOp,
): Promise<void> {
  const preview = await bridge.maintenance!(connection, { kind: 'preview', schema, table, operation })
  if (!preview.id) throw new Error('无法预览变更')
  try {
    const result = await bridge.maintenance!(connection, { kind: 'execute', id: preview.id, confirmed: true })
    if (result.status !== 'success') throw new Error(result.message || '结果未知，请核验数据库实际状态。')
  } catch (error) {
    await bridge.maintenance!(connection, { kind: 'reject', id: preview.id }).catch(() => {})
    throw error
  }
}

import type { WorkspaceBridge } from './workbench.ts'

export type SaveExperienceOutcome = { id: string; merged: boolean }

export async function publishExperienceFromSql(
  bridge: WorkspaceBridge,
  input: { sql: string; dialect: string; connectionId: string; title: string },
): Promise<SaveExperienceOutcome> {
  const saved = await bridge.templates!('template-publish', {
    sql: input.sql,
    dialect: input.dialect,
    connectionId: input.connectionId,
    title: input.title,
    publishAction: 'fromSql',
  }) as { id: string; merged?: boolean }
  return { id: saved.id, merged: !!saved.merged }
}

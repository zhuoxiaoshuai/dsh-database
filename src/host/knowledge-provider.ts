import type { DataSourceId } from '../shared/data-sources/types.ts'
import type { SqlTemplateStore } from './sql-template-store.ts'

export type KnowledgeProvider<Id extends string = DataSourceId> = {
  id: Id
  dispatch(store: SqlTemplateStore, connectionId: string, body: Record<string, unknown>): Promise<unknown> | unknown
}

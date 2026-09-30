import type { CatalogResult } from '../shared/workbench.ts'

export type IndexSummary = { name: string; type: string; unique: string; columns: string }

export function indexRowsFromCatalog(detail: CatalogResult | undefined): IndexSummary[] {
  return (detail?.indexes?.values || []).map(item => ({
    name: item.name,
    type: item.type,
    unique: item.unique ? 'YES' : 'NO',
    columns: item.columns.join(', '),
  }))
}

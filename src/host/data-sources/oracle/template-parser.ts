import type { ParsedTemplateFeatures } from '../../sql-template-normalizer.ts'

export async function parseTemplate(sql: string): Promise<ParsedTemplateFeatures | undefined> {
  const { collectOracleTemplateAst } = await import('./template-ast.ts')
  return collectOracleTemplateAst(sql)
}

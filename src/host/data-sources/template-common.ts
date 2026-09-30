export type TemplateRisk = 'readonly' | 'dml' | 'ddl' | 'unknown'

export function riskOf(operation: string): TemplateRisk {
  if (operation === 'select' || operation === 'with') return 'readonly'
  if (['insert', 'update', 'delete', 'replace', 'merge'].includes(operation)) return 'dml'
  if (['create', 'alter', 'drop', 'truncate', 'rename', 'comment'].includes(operation)) return 'ddl'
  return 'unknown'
}

export function classify(sql: string): string {
  const text = sql.trim().replace(/^\(+/, '').replace(/;+\s*$/, '')
  const head = text.match(/^(with|select|insert|update|delete|replace|merge|create|alter|drop|truncate|rename|comment)\b/i)
  return head ? head[1].toLowerCase() : 'unknown'
}

export function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort()
}

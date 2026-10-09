export type RedactionAction = 'allow' | 'mask' | 'omit'
export type RedactionRule = {
  connectionId?: string
  schema?: string
  table?: string
  column: string
  action: RedactionAction
}

export function queryColumnsReliable(sql: string, tableCount: number): boolean {
  if (tableCount !== 1) return false
  if (/\bjoin\b/i.test(sql) || /\bunion\b/i.test(sql)) return false
  if (/\(.*select\b/i.test(sql)) return false
  const select = sql.match(/^\s*select\s+([\s\S]+?)\s+from\s+/i)
  if (!select) return false
  const list = select[1].trim()
  if (list === '*' || /[()]/u.test(list)) return false
  return list.split(',').every(part => {
    const name = part.trim().split(/\s+as\s+|\s+/i)[0]
    return /^("([^"]|"")+"|`([^`]+)`|[A-Za-z_][A-Za-z0-9_$#]*)$/.test(name) && !name.includes('.')
  })
}

export function maskCell(value: string | null): { masked: true; type: string; length?: number; empty?: boolean } {
  if (value === null) return { masked: true, type: 'null' }
  return { masked: true, type: 'string', length: value.length, empty: value.length === 0 }
}

export function redactQueryResult(input: {
  sql: string
  tables: string[]
  schema?: string
  connectionId?: string
  columns: string[]
  binaryColumns?: number[]
  rows: (string | null)[][]
  truncated: boolean
  elapsedMs: number
  executionId: string
  rules?: RedactionRule[]
}): Record<string, unknown> {
  const reliable = queryColumnsReliable(input.sql, input.tables.length)
  const rules = input.rules || []
  const actions = input.columns.map((column, index) => {
    if (!reliable) return 'omit' as RedactionAction
    const match = rules.find(rule =>
      rule.column.toLowerCase() === column.toLowerCase()
      && (!rule.connectionId || rule.connectionId === input.connectionId)
      && (!rule.schema || rule.schema === input.schema)
      && (!rule.table || input.tables.some(table => table === rule.table))
    )
    return match?.action || 'allow'
  })
  const cells = input.rows.map(row => row.map((value, i) => {
    const action = actions[i]
    if (action === 'allow') return value
    if (action === 'mask') return maskCell(value)
    return undefined
  }))
  const hasValues = actions.some(action => action !== 'omit')
  return {
    ok: true,
    executionId: input.executionId,
    columns: input.columns,
    ...(input.binaryColumns ? { binaryColumns: input.binaryColumns } : {}),
    rowCount: input.rows.length,
    truncated: input.truncated,
    elapsedMs: input.elapsedMs,
    redaction: actions,
    ...(hasValues ? { rows: cells } : {}),
  }
}

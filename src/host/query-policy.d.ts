declare module './query-policy.mjs' {
  export function authorizeSelect(dialect: string, sql: string, schema: string): Promise<{
    sql: string
    tables: string[]
    references: unknown[]
    aliases: string[]
    kind?: string
  }>
  export function authorizeStatement(dialect: string, sql: string, schema: string): Promise<{
    sql: string
    tables: string[]
    references: unknown[]
    aliases: string[] | unknown
    kind: 'select' | 'write' | 'explain' | 'show'
    targets?: { schema: string; name: string }[]
  }>
  export function splitStatements(sql: string, dialect?: string): string[]
}

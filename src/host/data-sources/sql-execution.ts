import { authorizeStatement } from '../query-policy.mjs'
import { isWritableEnvironment } from '../../shared/connection-permission.ts'
import { DEFAULT_QUERY_PAGE_SIZE } from '../../shared/limits.ts'
import { sqlCompletion, classifySqlInterruption } from '../sql-operation.ts'
import type { Result } from '../../shared/workbench.ts'
import type { PreparedTextOperation, StandardTextExecution } from './module-types.ts'

export type SqlAuthorizedStatement = Awaited<ReturnType<typeof authorizeStatement>>
/** SQL-only entry adaptation and Worker proof; other source operations cannot carry them. */
export type SqlTextEntryOptions = { sourceKind: 'sql'; entry?: 'default' | 'query' | 'manual-query' | 'shared-query' | 'explain'; input?: Record<string, unknown> }
export type SqlWorkerAuthorization = { kind: string; sql: string; tables: string[]; targets?: { schema: string; name: string }[] }
export type SqlPreparedState = { sourceKind: 'sql'; entry: NonNullable<SqlTextEntryOptions['entry']>; authorized?: SqlWorkerAuthorization }

/** Shared SQL coordination; parsing and execution stay in the dialect Providers and Worker. */
export function createSqlTextExecution(dialect: 'mysql' | 'oracle'): StandardTextExecution {
  return {
    mode: 'standard-text',
    normalizeContext(raw, binding) {
      if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || Object.keys(raw).some(key => key !== 'schema')
        || ('schema' in raw && typeof raw.schema !== 'string'))) throw new Error('SQL 执行目标无效。')
      return { schema: (raw as { schema?: string } | undefined)?.schema ?? binding.database }
    },
    prepareText(text, context, options) {
      if (options && options.sourceKind !== 'sql') throw new Error('SQL 文本执行入口无效。')
      const entry = options?.entry ?? 'default'
      if (!['default', 'query', 'manual-query', 'shared-query', 'explain'].includes(entry)) throw new Error('SQL 文本执行入口无效。')
      const manual = entry === 'default' || entry === 'manual-query'
      const input = options?.input ? { ...options.input } : { sql: text, schema: context.schema, limit: DEFAULT_QUERY_PAGE_SIZE }
      return { sourceKind: 'sql', entry, action: manual ? 'manual-query' : 'query', text: text as string, input,
        recordPolicy: entry === 'shared-query' || entry === 'explain' ? 'external' : 'none',
        operation: entry === 'explain' ? 'database_explain_plan' : 'database_execute_sql', title: '执行当前 SQL',
        summarize: result => sqlCompletion(result as unknown as Result, result.affectedRows !== undefined ? 'write' : 'select').conclusion,
        classifyInterruption: classifySqlInterruption, completedResultIsDefinitive: true }
    },
    async authorize(prepared, actor, binding, options) {
      if (options && options.sourceKind !== 'sql') throw new Error('SQL 执行授权无效。')
      prepared.queue = actor === 'ai' ? 'ai' : 'manual'
      prepared.input = { ...prepared.input, lane: actor === 'user' ? 'manual' : 'query' }
      const entry = options?.entry ?? 'default'
      if (prepared.sourceKind !== 'sql' || binding.dialect !== dialect || !['user', 'ai'].includes(actor) || prepared.entry !== entry
        || prepared.action !== (entry === 'default' || entry === 'manual-query' ? 'manual-query' : 'query')) throw new Error('SQL 执行授权无效。')
      if (['default', 'query', 'manual-query'].includes(entry) && actor !== 'user') throw new Error('此 SQL 入口仅允许人工调用。')
      const statement = await authorizeStatement(dialect, prepared.text, prepared.input.schema)
      prepared.text = statement.sql
      prepared.input = { ...prepared.input, sql: statement.sql }
      prepared.authorized = { kind: statement.kind, sql: statement.sql, tables: statement.tables,
        ...(statement.targets ? { targets: statement.targets } : {}) }
      if (statement.kind === 'show' && entry === 'shared-query') throw new Error('AI Query 暂不执行 SHOW，请使用对象详情或 SQL 查询页。')
      prepared.classifyInterruption = (error, lifecycle) => classifySqlInterruption(error, { ...lifecycle, write: statement.kind === 'write' })
      if (statement.kind === 'write' && actor === 'ai' && !isWritableEnvironment(binding.environment)) throw new Error('只读权限连接不能提交写入。')
      return statement
    },
  }
}

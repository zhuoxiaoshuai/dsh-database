import { defineTool } from '@deepseek-ai/dsh-tools'
import { catalogStatement, visibleCatalogSql } from './catalog.mjs'
import { redactQueryResult, sanitizeToolError, type RedactionRule } from './ai-redaction.ts'
import type { ConnectionService } from './connection-service.ts'
import type { ExecutionStore } from './execution-store.ts'
import { isWritableEnvironment } from '../shared/connection-permission.ts'
import { executionStop, isHostQueryTimeout } from '../shared/execution.ts'
import type { DatabaseOperation } from '../shared/database-actions.ts'
import { draftSelects, quoteIdentifier, type CatalogResult, type Connection, type Dialect, type SqlDialect } from '../shared/workbench.ts'
import { dialectCapabilities } from '../shared/dialect-capabilities.ts'
import { databaseGuideTopics, lookupDatabaseGuide } from './ai-tool-guides.ts'
import { workbenchEditorViews } from './workbench-editors.ts'
import { getSourceRuntime } from './data-sources/runtime-registry.mjs'

// 构建时由 build.mjs 从 package.json 注入；源码直跑（测试）时回落 'dev'
declare const __PLUGIN_VERSION__: string
const PLUGIN_VERSION = typeof __PLUGIN_VERSION__ === 'string' ? __PLUGIN_VERSION__ : 'dev'

type ToolExecution = {
  callId?: string
  rootCallId?: string
  signal?: AbortSignal
  agent?: { session?: { id?: string } }
}

function mergeSignal(source?: AbortSignal): AbortController {
  const controller = new AbortController()
  if (source?.aborted) controller.abort()
  else source?.addEventListener('abort', () => controller.abort(), { once: true })
  return controller
}

function sessionId(execution: ToolExecution, validOwner: (id: string) => boolean): string {
  const id = execution.agent?.session?.id || ''
  if (!validOwner(id)) throw new Error('当前工具调用缺少有效对话身份，未访问任何数据库。')
  return id
}

function liveConnection(service: ConnectionService, session: string, connectionId: unknown, generation: unknown): Connection {
  if (typeof connectionId !== 'string' || typeof generation !== 'string') throw new Error('请提供有效的 connectionId 和 generation。')
  const connection = ownedConnection(service, session, connectionId)
  if (!connection.live) throw new Error('请先连接数据库。')
  if (connection.generation !== generation) throw new Error('连接已变化或当前对话已失效，请刷新。')
  return connection
}

function ownedConnection(service: ConnectionService, session: string, connectionId: unknown): Connection & { dialect: SqlDialect } {
  if (typeof connectionId !== 'string' || !connectionId) throw new Error('请提供有效的 connectionId。')
  const connection = service.list(session).find(item => item.id === connectionId)
  if (!connection) throw new Error('连接不存在。')
  if (getSourceRuntime(connection.dialect).documentKind !== 'sql') throw new Error('此工具仅适用于 SQL 数据源。')
  return connection as Connection & { dialect: SqlDialect }
}

async function withRecord<T>(
  executions: ExecutionStore,
  execution: ToolExecution,
  session: string,
  connection: Connection | undefined,
  operation: DatabaseOperation,
  details: { schema?: string; tables?: string[]; sql?: string; params?: unknown; draft?: Record<string, unknown>; title?: string; reason?: string },
  work: (id: string, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const record = executions.create({
    conversationId: session,
    callId: typeof execution.callId === 'string' ? execution.callId : '',
    rootCallId: typeof execution.rootCallId === 'string' ? execution.rootCallId : '',
    connectionId: connection?.id,
    generation: connection?.generation,
    connectionName: connection?.name,
    dialect: connection?.dialect,
    environment: connection?.environment,
    schema: details.schema,
    operation,
    tables: details.tables,
    sql: details.sql,
    params: details.params,
    draft: details.draft,
    initiator: 'ai',
    title: details.title,
    reason: details.reason,
  })
  const controller = mergeSignal(execution.signal)
  executions.attachAbort(record.executionId, controller)
  executions.transition(record.executionId, 'checking')
  try {
    const value = await work(record.executionId, controller.signal)
    return value
  } catch (error) {
    const message = sanitizeToolError(error instanceof Error ? error.message : '操作失败')
    const dispatched = executions.dispatched(record.executionId)
    const stop = executionStop({ aborted: !!controller.signal.aborted, dispatched, message })
    if (isHostQueryTimeout(message)) executions.complete(record.executionId, 'failed', message)
    else if (stop.status !== 'failed') executions.complete(record.executionId, stop.status, stop.message)
    else if (/超时|timeout/i.test(message)) {
      executions.event(record.executionId, 'timeout', message)
      executions.complete(record.executionId, 'unknown', message)
    } else if (/连接已关闭|连接已变化/.test(message)) {
      executions.event(record.executionId, 'disconnect', message)
      executions.complete(record.executionId, 'unknown', message)
    } else executions.complete(record.executionId, 'failed', message)
    throw new Error(isHostQueryTimeout(message) || stop.status === 'failed' ? message : stop.message)
  }
}

function catalogUnavailable(result: CatalogResult | undefined): string | undefined {
  const bags = [result, result?.indexes, result?.constraints, result?.definition, result?.storage] as { status?: string; reason?: string }[]
  const hit = bags.find(item => item && item.status === 'unavailable')
  return hit?.reason
}

const SYSTEM_SCHEMA = /^(information_schema|mysql|performance_schema|sys|sysaux|system)$/i
function clipName(value: unknown, max = 40): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > max ? text.slice(0, max) + '…' : text
}

function queryDraft(sql?: string): Record<string, unknown> | undefined {
  return sql?.trim() ? { kind: 'query', sql } : undefined
}

function recordCatalogSql(executions: ExecutionStore, id: string, dialect: Dialect, input: Record<string, unknown>, extra?: { draft?: Record<string, unknown>; tables?: string[] }) {
  const statement = catalogStatement(dialect, input)
  executions.annotate(id, { sql: visibleCatalogSql(statement), params: statement.params, draft: extra?.draft, tables: extra?.tables })
}

function schemasDraft(dialect: Dialect, items?: Record<string, unknown>[]) {
  const rows = (items || []).filter(item => !SYSTEM_SCHEMA.test(String(item.name || '')))
  if (!rows.length) return
  const q = (name: string) => quoteIdentifier(dialect, name)
  const limit = dialectCapabilities(dialect).pageClause(100, 0).replace(/^OFFSET 0 ROWS /, '')
  const notes = rows.slice(0, 20).map(item => `-- ${item.name} · 基表 ${item.tables ?? '?'} · 视图 ${item.views ?? '?'}`).join('\n')
  return queryDraft(`${notes}\n\n-- 把「请填写表名」改成真实表名后，选中下面语句运行\nSELECT * FROM ${q(String(rows[0].name))}.${q('请填写表名')}\n${limit};`)
}

function tablesDraft(dialect: Dialect, schema: string, items?: Record<string, unknown>[]) {
  const names = (items || []).map(item => String(item.name || '')).filter(Boolean)
  return queryDraft(draftSelects(dialect, schema, names.length ? names : ['请填写表名']))
}

export function registerAiTools(ctx: { tools: { register(tool: unknown): void } }, service: ConnectionService, executions: ExecutionStore, validOwner: (id: string) => boolean, rules: RedactionRule[] = []): void {
  const json = (value: unknown) => JSON.stringify(value)
  const liveSummaries = (session: string) => service.list(session).filter(item => item.live).map(item => {
    const query = item.workbench?.sharedQuery
    return {
      connectionId: item.id,
      generation: item.generation,
      name: item.name,
      dialect: item.dialect,
      environment: item.environment,
      database: item.database,
      version: item.version,
      controller: query?.controller || 'ai',
      sharedQueryRevision: query?.revision || 1,
    }
  })
  const editorViews = (session: string) => workbenchEditorViews(service.snapshot(session))
  ctx.tools.register(defineTool({
    name: 'database_status',
    description: '查库用 database_*。当前 SQL 用 database_execute_sql action=read。',
    parameters: {
      topic: { type: 'string', description: '工具名或 workflow。省略则只返回状态。' },
    },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    async execute(args: { topic?: string }, execution: ToolExecution) {
      const session = sessionId(execution, validOwner)
      const loaded = lookupDatabaseGuide(args?.topic)
      if (typeof args?.topic === 'string' && args.topic.trim()) {
        if (!loaded) return json({ error: '未知 topic。', topics: databaseGuideTopics() })
        return json(loaded)
      }
      await service.restoreRemembered(session)
      const connections = liveSummaries(session)
      return json({
        stage: 'ready',
        pluginVersion: PLUGIN_VERSION,
        conversationId: session,
        defaultAccess: 'readonly',
        help: '当前 SQL、这个 SQL、看数据库里的 SQL 时，调用 database_execute_sql action=read。传工具名或 workflow 可加载用法。',
        templates: {
          published: service.templates.list().filter(item => !item.unpublished && !item.archived).length,
          tool: 'database_templates',
        },
        note: '查库用 database_*。当前 SQL、这个 SQL 用 database_execute_sql action=read。',
        next: connections.length ? [
          'database_execute_sql',
          'database_catalog',
          'database_templates',
          'database_import_connections',
        ] : [
          'database_import_connections',
          '请用户在数据库工作台登录连接，然后调用 database_status',
        ],
        connections,
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'database_import_connections',
    description: '只登记不登录。',
    parameters: {
      connections: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            dialect: { type: 'string', enum: ['mysql', 'oracle', 'redis'] },
            host: { type: 'string' },
            port: { type: 'integer' },
            database: { type: 'string' },
            oracleMode: { type: 'string', enum: ['service', 'sid'] },
            redisMode: { type: 'string', enum: ['standalone', 'sentinel', 'cluster'] },
            sentinelMaster: { type: 'string' },
            username: { type: 'string' },
            environment: { type: 'string', enum: ['sit', 'uat', 'pvt'] },
          },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    async execute(args: { connections?: unknown[] }, execution: ToolExecution) {
      const session = sessionId(execution, validOwner)
      return await withRecord(executions, execution, session, undefined, 'database_import_connections', {
        title: '批量登记数据库连接，供稍后在工作台补密码登录',
        reason: '从外部清单导入连接信息，不保存密码、不发起登录。',
      }, async id => {
        executions.event(id, 'check-passed')
        executions.transition(id, 'running')
        const result = service.importConnections(session, args.connections)
        const created = result.created.map(item => ({
          connectionId: item.id,
          name: item.name,
          dialect: item.dialect,
          host: item.settings && 'host' in item.settings ? item.settings.host : undefined,
          port: item.settings && 'port' in item.settings ? item.settings.port : undefined,
          database: item.settings && 'database' in item.settings ? item.settings.database : item.database,
          username: item.settings?.username,
          environment: item.environment,
          live: false,
          hasPassword: false,
        }))
        const message = `已登记 ${created.length} 条，跳过 ${result.skipped.length} 条。`
        executions.complete(id, 'succeeded', message, undefined, message)
        return json({ executionId: id, created, skipped: result.skipped, message })
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'database_catalog',
    description: '字典结构，勿用 information_schema。',
    parameters: {
      connectionId: { type: 'string', required: true },
      generation: { type: 'string', required: true },
      kind: { type: 'string', enum: ['schemas', 'tables', 'table'], required: true },
      schema: { type: 'string' },
      table: { type: 'string' },
      search: { type: 'string' },
      offset: { type: 'integer' },
    },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    async execute(args: { connectionId: string; generation: string; kind?: string; schema?: string; table?: string; search?: string; offset?: number }, execution: ToolExecution) {
      const session = sessionId(execution, validOwner)
      const connection = liveConnection(service, session, args.connectionId, args.generation)
      const kind = args.kind
      if (kind !== 'schemas' && kind !== 'tables' && kind !== 'table') throw new Error('kind 须为 schemas、tables 或 table。')
      if ((kind === 'tables' || kind === 'table') && !args.schema) throw new Error('请提供 schema。')
      if (kind === 'table' && !args.table) throw new Error('请提供 table。')
      const title = kind === 'schemas'
        ? `列出 ${clipName(connection.name)} 的数据库，确认可见库和表数量`
        : kind === 'tables'
          ? (args.search
            ? `查找 ${clipName(args.schema)} 中匹配“${clipName(args.search, 24)}”的表，定位业务表`
            : `查找 ${clipName(args.schema)} 中的表，确认有哪些业务表`)
          : `查看 ${clipName(args.schema)}.${clipName(args.table)} 的结构，确认字段后再写查询`
      const reason = kind === 'schemas'
        ? '为确认可见 Schema 和表数量。'
        : kind === 'tables'
          ? (args.search ? `按名称或字段匹配“${clipName(args.search, 24)}”，定位可用业务表。` : `浏览 ${clipName(args.schema)} 的表和视图，便于后续查询。`)
          : '为确认字段、索引和约束后再写查询。'
      return await withRecord(executions, execution, session, connection, 'database_catalog', {
        schema: kind === 'schemas' ? undefined : args.schema,
        tables: kind === 'table' && args.table ? [args.table] : undefined,
        title,
        reason,
      }, async (id, signal) => {
        executions.event(id, 'check-passed')
        executions.transition(id, 'running')
        executions.event(id, 'dispatched')
        if (kind === 'schemas') {
          const input = { kind: 'schemas' as const, offset: args.offset || 0 }
          recordCatalogSql(executions, id, connection.dialect, input, { draft: schemasDraft(connection.dialect, []) })
          const result = await service.catalog(session, connection.id, connection.generation, input, signal)
          const unavailable = catalogUnavailable(result)
          const sql = visibleCatalogSql(catalogStatement(connection.dialect, input))
          recordCatalogSql(executions, id, connection.dialect, input, { draft: schemasDraft(connection.dialect, result.items) })
          if (unavailable) {
            executions.complete(id, 'failed', unavailable, undefined, `无法列出数据库：${unavailable}`)
            return json({ executionId: id, unavailable: true, reason: unavailable, sql })
          }
          const count = (result.items || []).length
          executions.complete(id, 'succeeded', undefined, undefined, count ? `列出 ${count} 个数据库。` : '没有可见数据库。')
          return json({ executionId: id, items: result.items || [], more: !!result.more, source: result.source, collectedAt: result.collectedAt, sql })
        }
        if (kind === 'tables') {
          const input = { kind: 'tables' as const, schema: args.schema || '', search: args.search, offset: args.offset || 0 }
          recordCatalogSql(executions, id, connection.dialect, input)
          const result = await service.catalog(session, connection.id, connection.generation, input, signal)
          const unavailable = catalogUnavailable(result)
          const sql = visibleCatalogSql(catalogStatement(connection.dialect, input))
          const names = (result.items || []).map(item => String(item.name || '')).filter(Boolean)
          recordCatalogSql(executions, id, connection.dialect, input, { draft: tablesDraft(connection.dialect, args.schema || '', result.items), tables: names })
          if (unavailable) {
            executions.complete(id, 'failed', unavailable, undefined, `无法查找表：${unavailable}`)
            return json({ executionId: id, unavailable: true, reason: unavailable, sql })
          }
          executions.complete(id, 'succeeded', undefined, undefined, names.length ? `查询成功，返回 ${names.length} 张表，可继续查下一个库。` : '查询成功，未找到匹配的表。')
          return json({ executionId: id, items: result.items || [], more: !!result.more, estimated: true, source: result.source, collectedAt: result.collectedAt, sql })
        }
        const input = { kind: 'table' as const, schema: args.schema || '', table: args.table || '' }
        recordCatalogSql(executions, id, connection.dialect, input, { draft: queryDraft(draftSelects(connection.dialect, args.schema || '', [args.table || ''])) })
        const result = await service.catalog(session, connection.id, connection.generation, input, signal)
        let indexes = result.indexes
        if (dialectCapabilities(connection.dialect).supportsShowIndex) {
          const indexPage = await service.catalog(session, connection.id, connection.generation, { kind: 'indexes', schema: args.schema || '', table: args.table || '' }, signal)
          indexes = indexPage.indexes
        }
        const sql = visibleCatalogSql(catalogStatement(connection.dialect, input))
        const columns = result.columns || []
        executions.complete(id, 'succeeded', undefined, undefined, Array.isArray(columns) ? `读取到 ${columns.length} 个字段。` : '已读取表结构。')
        return json({
          executionId: id,
          columns: result.columns || [],
          indexes,
          constraints: result.constraints,
          storage: result.storage,
          definition: result.definition,
          source: result.source,
          collectedAt: result.collectedAt,
          truncated: result.truncated,
          sql,
        })
      })
    },
  }))

  const executeSqlTool = (name: string, description: string) => defineTool({
    name,
    description,
    parameters: {
      connectionId: { type: 'string' },
      generation: { type: 'string' },
      schema: { type: 'string' },
      sql: { type: 'string' },
      action: { type: 'string', enum: ['read'], description: '当前 SQL、这个 SQL、看数据库 SQL 时传 read。' },
      purpose: { type: 'string', enum: ['verify', 'result'], description: 'verify 只回给模型；result 发布到工作台。' },
      limit: { type: 'integer' },
    },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    async execute(args: { connectionId?: string; generation?: string; schema?: string; sql?: string; action?: string; purpose?: string; limit?: number }, execution: ToolExecution) {
      const session = sessionId(execution, validOwner)
      const sql = typeof args.sql === 'string' ? args.sql.trim() : ''
      if (args.action === 'read') {
        const snap = service.snapshot(session)
        const live = snap.connections.filter(item => item.live)
        const item = args.connectionId
          ? live.find(row => row.id === args.connectionId)
          : live.find(row => row.id === snap.lastActiveId) || live[0]
        if (!item) throw new Error('请先连接数据库。')
        if (args.generation && item.generation !== args.generation) throw new Error('连接已变化或当前对话已失效，请刷新。')
        const current = service.getSharedQuery(session, item.id)
        return json({
          action: 'read',
          connectionId: item.id,
          generation: item.generation,
          name: item.name,
          schema: current.schema || item.workbench?.schema || item.database,
          sql: current.sql || '',
          controller: current.controller || 'ai',
          revision: current.revision || 1,
          lastRun: current.lastRun,
          help: '这是工作台 AI Query 的当前语句。要执行把同一段 sql 连同 connectionId、generation、schema 传回本工具。',
        })
      }
      if (!sql) throw new Error('看当前 SQL 请传 action=read；执行请提供 sql。')
      if (!args.connectionId || !args.generation || !args.schema) throw new Error('执行 SQL 需要 connectionId、generation 和 schema。')
      const connection = liveConnection(service, session, args.connectionId, args.generation)
      const current = service.getSharedQuery(session, connection.id)
      const outcome = await service.runSharedQuery(session, {
        connectionId: connection.id,
        generation: connection.generation,
        schema: args.schema,
        sql,
        revision: current.revision,
        purpose: args.purpose === 'verify' || args.purpose === 'result' ? args.purpose : undefined,
        initiator: 'ai',
        callId: execution.callId,
        rootCallId: execution.rootCallId,
        limit: args.limit,
      }, mergeSignal(execution.signal).signal)
      const model = outcome.model && typeof outcome.model === 'object' ? { ...outcome.model as Record<string, unknown> } : {}
      const tables = Array.isArray(outcome.tables) ? outcome.tables : []
      const sit = isWritableEnvironment(connection.environment)
      const redactRows = (sql: string, columns: string[], rows: (string | null)[][], truncated: boolean, elapsedMs: number) => redactQueryResult({
        sql, tables, schema: args.schema, connectionId: connection.id, columns, rows: rows.slice(0, 100), truncated, elapsedMs, executionId: String(outcome.executionId || ''), rules,
      })
      if (!sit && Array.isArray(model.rows) && outcome.result && typeof outcome.result === 'object') {
        const result = outcome.result as { columns?: string[]; rows?: (string | null)[][]; truncated?: boolean; elapsedMs?: number }
        const redacted = redactRows(String(outcome.sql || args.sql), Array.isArray(result.columns) ? result.columns : [], result.rows || [], !!result.truncated, Number(result.elapsedMs || 0))
        delete model.rows
        Object.assign(model, redacted)
      }
      if (!sit && Array.isArray(model.statements)) {
        model.statements = model.statements.map(item => {
          if (!item || typeof item !== 'object') return item
          const row = item as { sql?: string; columns?: string[]; rows?: (string | null)[][]; truncated?: boolean; elapsedMs?: number }
          if (!Array.isArray(row.rows)) return item
          const redacted = redactRows(String(row.sql || outcome.sql || args.sql), Array.isArray(row.columns) ? row.columns : [], row.rows, !!row.truncated, Number(row.elapsedMs || 0))
          const { rows: _rows, ...rest } = row
          return { ...rest, ...redacted }
        })
      }
      return json({
        ok: true,
        status: 'succeeded',
        sql: outcome.sql,
        tables,
        schema: args.schema,
        connectionId: connection.id,
        executionId: outcome.executionId,
        controlLost: !!outcome.controlLost,
        ...model,
      })
    },
  })
  ctx.tools.register(executeSqlTool('database_execute_sql', '当前 SQL、这个 SQL、看数据库 SQL：action=read。传入 sql 则执行。SIT 可写。'))

  ctx.tools.register(defineTool({
    name: 'database_templates',
    description: '经验库：search / get / save。',
    parameters: {
      action: { type: 'string', enum: ['search', 'get', 'save'], required: true },
      query: { type: 'string' },
      connectionId: { type: 'string' },
      dialect: { type: 'string' },
      id: { type: 'string' },
      sql: { type: 'string' },
      title: { type: 'string' },
      summary: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    async execute(args: { action?: string; query?: string; connectionId?: string; dialect?: string; id?: string; sql?: string; title?: string; summary?: string; tags?: string[] }, execution: ToolExecution) {
      const session = sessionId(execution, validOwner)
      const action = args.action
      if (action !== 'search' && action !== 'get' && action !== 'save') throw new Error('action 须为 search、get 或 save。')
      if (action === 'get') {
        if (!args.id) throw new Error('请提供 id。')
        return await withRecord(executions, execution, session, undefined, 'database_templates', {
          title: '读取 SQL 经验原文，仍须通过当前连接策略',
          reason: '为查看可执行 SQL，仍须通过当前连接策略。',
        }, async id => {
          const item = service.templates.get(args.id || '', true)
          if (!item) throw new Error('模板不存在、未发布或已归档。')
          executions.event(id, 'check-passed')
          executions.transition(id, 'running')
          executions.annotate(id, { sql: item.originalSql, draft: queryDraft(item.originalSql) })
          executions.complete(id, 'succeeded', undefined, undefined, `已读取模板「${clipName(item.title)}」。`)
          return json({
            executionId: id,
            id: item.id, title: item.title, summary: item.summary, tags: item.tags, dialect: item.dialect,
            originalSql: item.originalSql, features: item.features, version: item.version, familyId: item.familyId,
          })
        })
      }
      if (action === 'save') {
        if (!args.connectionId || !args.sql || !args.title) throw new Error('保存经验需要 connectionId、title 和 sql。')
        const connection = ownedConnection(service, session, args.connectionId)
        return await withRecord(executions, execution, session, connection, 'database_templates', {
          sql: args.sql,
          title: `保存 SQL 经验“${clipName(args.title, 24)}”`,
          reason: '将稳定可复用的 SQL 写入经验库供后续检索。',
        }, async id => {
          executions.event(id, 'check-passed')
          executions.transition(id, 'running')
          const saved = await service.templates.publishFromSql({
            sql: args.sql || '',
            dialect: connection.dialect,
            connectionId: connection.id,
            title: args.title || '',
            summary: args.summary,
            tags: args.tags,
          })
          const message = saved.merged ? `已合并到已有经验「${clipName(saved.title)}」。` : `已保存经验「${clipName(saved.title)}」。`
          executions.complete(id, 'succeeded', message, undefined, message)
          return json({ executionId: id, id: saved.id, title: saved.title, merged: saved.merged, version: saved.version, message })
        })
      }
      const connection = args.connectionId ? ownedConnection(service, session, args.connectionId) : undefined
      const dialect = args.dialect || connection?.dialect
      return await withRecord(executions, execution, session, connection, 'database_templates', {
        title: args.query ? `检索 SQL 经验“${clipName(args.query, 24)}”，复用已发布写法` : '检索最近 SQL 经验，复用已发布写法',
        reason: '为复用已发布的查询写法。',
      }, async id => {
        executions.event(id, 'check-passed')
        executions.transition(id, 'running')
        const items = service.templates.search(args.query || '', dialect, connection?.id).map(item => ({
          id: item.id, title: item.title, summary: item.summary, tags: item.tags, dialect: item.dialect,
          operation: item.features.operation, tables: item.features.tables, risk: item.features.risk, version: item.version,
        }))
        executions.complete(id, 'succeeded', `检索到 ${items.length} 条模板。`, undefined, items.length ? `检索到 ${items.length} 条模板。` : '没有匹配的 SQL 经验。')
        return json({ executionId: id, items })
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'database_read_collab',
    description: '读取查询页页签。当前 SQL 用 database_execute_sql action=read。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    async execute(_args: unknown, execution: ToolExecution) {
      const session = sessionId(execution, validOwner)
      return await withRecord(executions, execution, session, undefined, 'database_read_collab', {
        title: '读取当前 AI Query，核对用户是否已改写或接管',
        reason: '用户可能已改过语句或接管控制权。',
      }, async id => {
        executions.event(id, 'check-passed')
        executions.transition(id, 'running')
        const items = editorViews(session)
        executions.annotate(id, { sql: items[0]?.activeQuery?.sql || items[0]?.aiQuery?.sql, draft: queryDraft(items[0]?.activeQuery?.sql || items[0]?.aiQuery?.sql) })
        executions.complete(id, 'succeeded', items.length ? `已读取 ${items.length} 个连接上的当前 SQL。` : '工作台还没有 SQL。', undefined, items.length ? `已读取 ${items.length} 个连接上的当前 SQL。` : '工作台还没有 SQL。')
        return json({
          executionId: id,
          note: 'activeQuery 是查询页当前页签。aiQuery 是 AI Query。lastRun 无单元格。',
          items,
        })
      })
    },
  }))
}

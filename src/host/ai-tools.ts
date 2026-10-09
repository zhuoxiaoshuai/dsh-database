import { defineTool } from '@deepseek-ai/dsh-tools'
import { redactQueryResult, type RedactionRule } from './ai-redaction.ts'
import type { ConnectionService } from './connection-service.ts'
import type { ExecutionStore } from './execution-store.ts'
import { isWritableEnvironment } from '../shared/connection-permission.ts'
import { runLocalAiOperation } from './local-ai-operation.ts'
import { type Connection, type Result } from '../shared/workbench.ts'
import { databaseGuideTopics, lookupDatabaseGuide } from './ai-tool-guides.ts'
import { workbenchEditorViews } from './workbench-editors.ts'
import { aiConnectionHeal, resolveAiConnection } from './ai-connection-resolve.ts'

// 构建时由 build.mjs 从 package.json 注入；源码直跑（测试）时回落 'dev'
declare const __PLUGIN_VERSION__: string
const PLUGIN_VERSION = typeof __PLUGIN_VERSION__ === 'string' ? __PLUGIN_VERSION__ : 'dev'

type ToolExecution = {
  callId?: string
  rootCallId?: string
  signal?: AbortSignal
  agent?: { session?: { id?: string } }
}

function sessionId(execution: ToolExecution, validOwner: (id: string) => boolean): string {
  const id = execution.agent?.session?.id || ''
  if (!validOwner(id)) throw new Error('当前工具调用缺少有效对话身份，未访问任何数据库。')
  return id
}

function resolveSql<Live extends boolean = true>(service: ConnectionService, session: string, connectionId: unknown, generation: unknown, requireLive: Live = true as Live) {
  return resolveAiConnection({
    connections: service.list(session),
    family: 'sql',
    connectionId,
    generation,
    requireLive,
  })
}

function clipName(value: unknown, max = 40): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > max ? text.slice(0, max) + '…' : text
}

function queryDraft(sql?: string): Record<string, unknown> | undefined {
  return sql?.trim() ? { kind: 'query', sql } : undefined
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
    description: '先调本工具取 connectionId。查库用 database_*。当前 SQL 用 database_execute_sql action=read。',
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
        storageDegraded: service.storageDegraded || executions.storageDegraded,
        capabilities: { sql: true, manualSqlDml: 'account privileges in all environments', aiSqlDml: 'SIT only' },
        pluginVersion: PLUGIN_VERSION,
        conversationId: session,
        defaultAccess: 'readonly',
        help: '当前 SQL、这个 SQL、看数据库里的 SQL 时，调用 database_execute_sql action=read。传工具名或 workflow 可加载用法。',
        templates: {
          published: service.templates.list().filter(item => !item.unpublished && !item.archived).length,
          tool: 'database_templates',
        },
        note: '查库用 database_*。当前 SQL、这个 SQL 用 database_execute_sql action=read。',
        next: connections.length ? connections.flatMap(item => [
          { tool: 'database_execute_sql', args: { action: 'read', connectionId: item.connectionId, generation: item.generation } },
          { tool: 'database_catalog', args: { connectionId: item.connectionId, generation: item.generation, kind: 'schemas' } },
          { tool: 'database_templates', args: { action: 'search', connectionId: item.connectionId } },
        ]) : [
          { tool: 'database_import_connections', args: { connections: [] } },
          '请用户在数据库工作台登录连接，然后调用 database_status',
        ],
        connections,
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'database_import_connections',
    description: '登记主机，MySQL/Oracle/Redis/Kafka，不收密码不登录。',
    parameters: {
      connections: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            dialect: { type: 'string', enum: ['mysql', 'oracle', 'redis', 'kafka'] },
            host: { type: 'string' },
            port: { type: 'integer' },
            database: { type: 'string' },
            oracleMode: { type: 'string', enum: ['service', 'sid'] },
            redisMode: { type: 'string', enum: ['standalone', 'sentinel', 'cluster'] },
            brokers: { type: 'array', items: { type: 'string' } },
            tls: { type: 'boolean' },
            saslMechanism: { type: 'string', enum: ['none', 'plain', 'scram-sha-256', 'scram-sha-512'] },
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
      return await runLocalAiOperation(executions, execution, session, undefined, 'database_import_connections', {
        title: '批量登记数据库连接，供稍后在工作台补密码登录',
        reason: '从外部清单导入连接信息，不保存密码、不发起登录。',
      }, async context => {
        const id = context.executionId
        context.markChecked()
        context.markRunning()
        const result = service.importConnections(session, args.connections)
        const created = result.created.map(item => ({
          connectionId: item.id,
          name: item.name,
          dialect: item.dialect,
          host: item.settings && 'host' in item.settings ? item.settings.host : undefined,
          port: item.settings && 'port' in item.settings ? item.settings.port : undefined,
          database: item.settings && 'database' in item.settings ? item.settings.database : item.database,
          ...(item.settings && 'brokers' in item.settings ? { brokers: item.settings.brokers, tls: item.settings.tls, saslMechanism: item.settings.saslMechanism } : {}),
          username: item.settings?.username,
          environment: item.environment,
          live: false,
          hasPassword: false,
        }))
        const message = `已登记 ${created.length} 条，跳过 ${result.skipped.length} 条。`
        return { value: json({ executionId: id, created, skipped: result.skipped, message }), message, conclusion: message }
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'database_catalog',
    description: '表/列/库结构，MySQL Oracle。勿用 information_schema。',
    parameters: {
      connectionId: { type: 'string', description: '来自 database_status.connections。唯一已登录 SQL 连接可省略。' },
      generation: { type: 'string', description: '来自 database_status.connections。省略则用当前 generation。' },
      kind: { type: 'string', enum: ['schemas', 'tables', 'table'], required: true, description: 'schemas 可分页；tables 必须 schema；table 必须 schema 和 table。' },
      schema: { type: 'string' },
      table: { type: 'string' },
      search: { type: 'string' },
      offset: { type: 'integer' },
    },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    async execute(args: { connectionId?: string; generation?: string; kind?: string; schema?: string; table?: string; search?: string; offset?: number }, execution: ToolExecution) {
      const session = sessionId(execution, validOwner)
      const resolved = resolveSql(service, session, args.connectionId, args.generation)
      if (!resolved.ok) return json(resolved)
      const connection = resolved.connection
      return json(await service.executeCatalogTool(session, connection.id, connection.generation, args,
        execution.signal, execution.callId, execution.rootCallId))
    },
  }))

  const executeSqlTool = (name: string, description: string) => defineTool({
    name,
    description,
    parameters: {
      connectionId: { type: 'string', description: '来自 database_status.connections。action=read 或唯一已登录连接可省略。' },
      generation: { type: 'string', description: '来自 database_status.connections。省略则用当前 generation。' },
      schema: { type: 'string', description: '执行必填。action=read 可不传。' },
      sql: { type: 'string', description: '要执行的语句。看当前 SQL 时不传，改传 action=read。' },
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
      const resolved = resolveSql(service, session, args.connectionId, args.generation)
      if (!resolved.ok) return json(resolved)
      const connection = resolved.connection
      if (typeof args.schema !== 'string' || args.schema === '') {
        return json(aiConnectionHeal('sql', '执行 SQL 需要 schema。', [{
          connectionId: connection.id,
          generation: connection.generation,
          name: connection.name,
          dialect: connection.dialect,
        }]))
      }
      const current = service.getSharedQuery(session, connection.id)
      let outcome: Record<string, unknown>
      try { outcome = await service.runSharedQuery(session, {
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
      }, execution.signal) } catch (caught) {
        const receipt = caught as { steps?: Result['steps']; batch?: Result[]; effect?: string; phase?: string; executionId?: string; executionStatus?: string; message?: string }
        if (!receipt.steps) throw caught
        const statements = (receipt.batch || []).slice(0, 8).map(result => {
          const data = { ...result, rows: result.rows.slice(0, 100) }
          if (isWritableEnvironment(connection.environment)) return data
          const { rows: _rows, ...rest } = data
          return { ...rest, ...redactQueryResult({ sql: result.sql || sql, tables: [], schema: args.schema, connectionId: connection.id,
            columns: result.columns, rows: data.rows, truncated: result.truncated, elapsedMs: result.elapsedMs, executionId: receipt.executionId || '', rules }) }
        })
        return json({ ok: false, status: receipt.executionStatus || (receipt.effect === 'unknown' ? 'unknown' : 'failed'), executionId: receipt.executionId,
          error: receipt.message, phase: receipt.phase, steps: receipt.steps, statements, help: '成功步骤已经提交，不得重复执行；未知步骤须先核验。' })
      }
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
        return await runLocalAiOperation(executions, execution, session, undefined, 'database_templates', {
          title: '读取 SQL 经验原文，仍须通过当前连接策略',
          reason: '为查看可执行 SQL，仍须通过当前连接策略。',
        }, async context => {
          const id = context.executionId
          const item = service.templates.get(args.id || '', true)
          if (!item) throw new Error('模板不存在、未发布或已归档。')
          context.markChecked()
          context.markRunning()
          context.annotate({ sql: item.originalSql, draft: queryDraft(item.originalSql) })
          return { conclusion: `已读取模板「${clipName(item.title)}」。`, value: json({
            executionId: id,
            id: item.id, title: item.title, summary: item.summary, tags: item.tags, dialect: item.dialect,
            originalSql: item.originalSql, features: item.features, version: item.version, familyId: item.familyId,
          }) }
        })
      }
      if (action === 'save') {
        if (!args.sql || !args.title) throw new Error('保存经验需要 title 和 sql。')
        const resolved = resolveSql(service, session, args.connectionId, undefined, false)
        if (!resolved.ok) return json(resolved)
        const connection = resolved.connection
        return await runLocalAiOperation(executions, execution, session, connection, 'database_templates', {
          sql: args.sql,
          title: `保存 SQL 经验“${clipName(args.title, 24)}”`,
          reason: '将稳定可复用的 SQL 写入经验库供后续检索。',
        }, async context => {
          const id = context.executionId
          context.markChecked()
          context.markRunning()
          const saved = await service.templates.publishFromSql({
            sql: args.sql || '',
            dialect: connection.dialect,
            connectionId: connection.id,
            title: args.title || '',
            summary: args.summary,
            tags: args.tags,
          })
          const message = saved.merged ? `已合并到已有经验「${clipName(saved.title)}」。` : `已保存经验「${clipName(saved.title)}」。`
          return { message, conclusion: message, value: json({ executionId: id, id: saved.id, title: saved.title, merged: saved.merged, version: saved.version, message }) }
        })
      }
      let connection: Connection | undefined
      if (args.connectionId) {
        const resolved = resolveSql(service, session, args.connectionId, undefined, false)
        if (!resolved.ok) return json(resolved)
        connection = resolved.connection
      }
      const dialect = args.dialect || connection?.dialect
      return await runLocalAiOperation(executions, execution, session, connection, 'database_templates', {
        title: args.query ? `检索 SQL 经验“${clipName(args.query, 24)}”，复用已发布写法` : '检索最近 SQL 经验，复用已发布写法',
        reason: '为复用已发布的查询写法。',
      }, async context => {
        const id = context.executionId
        context.markChecked()
        context.markRunning()
        const items = service.templates.search(args.query || '', dialect, connection?.id).map(item => ({
          id: item.id, title: item.title, summary: item.summary, tags: item.tags, dialect: item.dialect,
          operation: item.features.operation, tables: item.features.tables, risk: item.features.risk, version: item.version,
        }))
        return { message: `检索到 ${items.length} 条模板。`, conclusion: items.length ? `检索到 ${items.length} 条模板。` : '没有匹配的 SQL 经验。', value: json({ executionId: id, items }) }
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
      return await runLocalAiOperation(executions, execution, session, undefined, 'database_read_collab', {
        title: '读取当前 AI Query，核对用户是否已改写或接管',
        reason: '用户可能已改过语句或接管控制权。',
      }, async context => {
        const id = context.executionId
        context.markChecked()
        context.markRunning()
        const items = editorViews(session)
        context.annotate({ sql: items[0]?.activeQuery?.sql || items[0]?.aiQuery?.sql, draft: queryDraft(items[0]?.activeQuery?.sql || items[0]?.aiQuery?.sql) })
        const message = items.length ? `已读取 ${items.length} 个连接上的当前 SQL。` : '工作台还没有 SQL。'
        return { message, conclusion: message, value: json({
          executionId: id,
          note: 'activeQuery 是查询页当前页签。aiQuery 是 AI Query。lastRun 无单元格。',
          items,
        }) }
      })
    },
  }))
}
